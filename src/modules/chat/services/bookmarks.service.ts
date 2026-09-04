import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { ChatBookmarkEntity } from '../entities/chat-bookmark.entity';
import { MessageEntity } from '../entities/message.entity';
import { ConversationEntity } from '../entities/conversation.entity';
import { MessagesService } from './messages.service';

/**
 * BookmarksService — a per-user "saved messages" store. Ported from the Mongo
 * chat-service `BookmarksService`.
 *
 * ISOLATION: a bookmark is private to the user who created it. Save re-uses the
 * exact message-isolation gate (`MessagesService.requireConversationMember`) so
 * a user can only bookmark a message in a conversation they participate in, in
 * their own org. Every read/write is scoped to `organizationId` AND `userId`.
 */
@Injectable()
export class BookmarksService {
  private readonly logger = new Logger(BookmarksService.name);

  constructor(
    @InjectRepository(ChatBookmarkEntity)
    private readonly bookmarks: Repository<ChatBookmarkEntity>,
    @InjectRepository(MessageEntity)
    private readonly messages: Repository<MessageEntity>,
    @InjectRepository(ConversationEntity)
    private readonly conversations: Repository<ConversationEntity>,
    private readonly messagesService: MessagesService,
  ) {}

  /**
   * Save a bookmark (participant-only). Idempotent per `(userId, messageId)`: a
   * repeat save is a no-op that returns the existing row. The composite-unique
   * index makes the idempotency race-safe.
   */
  async saveBookmark(orgId: string, userId: string, messageId: string) {
    const message = await this.messages.findOne({
      where: { id: messageId, isDeleted: false },
    });
    if (!message) throw new NotFoundException('Message not found');
    // Same-org + participant on the parent conversation.
    await this.messagesService.requireConversationMember(message.conversationId, orgId, userId);

    const existing = await this.bookmarks.findOne({ where: { userId, messageId } });
    if (existing) return existing;

    const entity = this.bookmarks.create({
      organizationId: orgId,
      userId,
      messageId,
      conversationId: message.conversationId,
    });
    try {
      return await this.bookmarks.save(entity);
    } catch (err: any) {
      // Two concurrent saves raced past the findOne — the unique index rejects
      // the loser. Return the winner.
      if (err?.code === '23505') {
        const winner = await this.bookmarks.findOne({ where: { userId, messageId } });
        if (winner) return winner;
      }
      throw err;
    }
  }

  /** Remove a bookmark (idempotent — removing a non-existent one still succeeds). */
  async removeBookmark(orgId: string, userId: string, messageId: string) {
    await this.bookmarks.delete({ organizationId: orgId, userId, messageId });
    return { message: 'Bookmark removed' };
  }

  /**
   * The caller's saved messages across conversations, newest first. Each is
   * enriched with its message and a light conversation label. Scoped to the
   * caller's org + userId.
   */
  async getBookmarks(orgId: string, userId: string) {
    const rows = await this.bookmarks.find({
      where: { userId, organizationId: orgId },
      order: { createdAt: 'DESC' },
    });
    if (!rows.length) return [];

    const messageIds = [...new Set(rows.map((r) => r.messageId))];
    const convIds = [...new Set(rows.map((r) => r.conversationId))];

    const msgs = messageIds.length
      ? await this.messages.find({ where: { id: In(messageIds) } })
      : [];
    const msgMap = new Map(msgs.map((m) => [m.id, m]));

    const convs = convIds.length
      ? await this.conversations.find({ where: { id: In(convIds) } })
      : [];
    const convMap = new Map(convs.map((c) => [c.id, c]));

    return rows.map((b) => {
      const m = msgMap.get(b.messageId) ?? null;
      const c = convMap.get(b.conversationId);
      const conversationLabel = c ? c.name || (c.type === 'direct' ? 'Direct message' : c.type) : null;
      return {
        ...b,
        _id: b.id,
        message: m ? { ...m, _id: m.id } : null,
        conversation: c ? { id: c.id, name: c.name, type: c.type } : null,
        conversationLabel,
      };
    });
  }
}
