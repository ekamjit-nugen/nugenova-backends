import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { IsNull, Repository } from 'typeorm';
import { createHash } from 'crypto';

import { ConversationEntity } from '../entities/conversation.entity';
import { Mention, MessageEntity, ReactionGroup } from '../entities/message.entity';
import { ConversationsService } from './conversations.service';
import { sanitizeHtml, toPlainText } from '../util/sanitize.util';
import { NotifierService } from '../../notification/notifier.service';
import { PresenceService } from '../realtime/presence.service';
import {
  CHAT_MESSAGE_DELETED,
  CHAT_MESSAGE_NEW,
  CHAT_MESSAGE_UPDATED,
} from '../realtime/chat-events';

/** The FE↔BE mention contract entry (see SendMessageDto.mentions). */
export interface IncomingMention {
  type: 'user' | 'here' | 'all';
  targetId: string;
}

// Window (ms) within which an identical resend with no client-supplied
// idempotencyKey is treated as a duplicate. Covers accidental double-sends
// (notably the image-attachment path, which historically omitted a key).
const AUTO_IDEMPOTENCY_WINDOW_MS = 10_000;

interface FileData {
  fileUrl?: string;
  fileName?: string;
  fileSize?: number;
  fileMimeType?: string;
  fileId?: string;
}

/**
 * MessagesService — send/list/edit/delete/read/react. Ported from the Mongo
 * chat-service `MessagesService`, Mongoose Model → TypeORM Repository.
 *
 * ISOLATION: every method that touches messages first resolves the parent
 * conversation via `conversationForMember`, which enforces same-org AND
 * caller-is-a-participant. Message rows also carry a denormalised
 * `organizationId` (copied from the conversation) as defence in depth.
 *
 * Deferred vs the monolith (see PLAYBOOK.md): slash-commands, DLP, AI
 * moderation, link-preview fetching, and the Socket.IO broadcast. The stored
 * message shape and the REST contract are preserved.
 */
@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(
    @InjectRepository(MessageEntity)
    private readonly messages: Repository<MessageEntity>,
    @InjectRepository(ConversationEntity)
    private readonly conversations: Repository<ConversationEntity>,
    private readonly conversationsService: ConversationsService,
    private readonly notifier: NotifierService,
    private readonly presence: PresenceService,
    private readonly events: EventEmitter2,
  ) {}

  /** Fire an in-process event, best-effort — never break a write on emit. */
  private safeEmit(event: string, payload: unknown): void {
    try {
      this.events.emit(event, payload);
    } catch (err) {
      this.logger.warn(`emit ${event} failed: ${String(err)}`);
    }
  }

  // ── access ──────────────────────────────────────────────────────────────

  /** Load the parent conversation, enforcing same-org AND participant. */
  private async conversationForMember(
    conversationId: string,
    orgId: string,
    userId: string,
  ): Promise<ConversationEntity> {
    const conv = await this.conversations.findOne({
      where: { id: conversationId, isDeleted: false },
    });
    if (!conv) throw new NotFoundException('Conversation not found');
    if (conv.organizationId && orgId && conv.organizationId !== orgId) {
      throw new NotFoundException('Conversation not found');
    }
    if (!conv.participants.some((p) => p.userId === userId)) {
      throw new ForbiddenException('You are not a participant of this conversation');
    }
    return conv;
  }

  /**
   * Public isolation gate — resolves the parent conversation enforcing same-org
   * AND participant, for sibling services (bookmarks) that must apply the exact
   * same check before touching a message. Delegates to `conversationForMember`.
   */
  async requireConversationMember(
    conversationId: string,
    orgId: string,
    userId: string,
  ): Promise<ConversationEntity> {
    return this.conversationForMember(conversationId, orgId, userId);
  }

  /** Preserve the Mongo `_id` shape as `id` (and keep `_id` for legacy FE). */
  private view(m: MessageEntity): Record<string, unknown> {
    return { ...m, _id: m.id };
  }

  // ── send ────────────────────────────────────────────────────────────────

  async sendMessage(
    conversationId: string,
    orgId: string,
    senderId: string,
    content: string | undefined,
    type = 'text',
    replyTo?: string,
    senderName?: string,
    fileData?: FileData,
    idempotencyKey?: string,
    mentions?: IncomingMention[],
    forwardedFrom?: Record<string, unknown> | null,
  ) {
    // Idempotency: use the client key, else a deterministic content+time-bucket
    // hash so a double-fired send collapses to one message. The partial-unique
    // index on idempotency_key makes the dedupe race-safe.
    const effectiveKey =
      idempotencyKey ||
      'auto:' +
        createHash('sha1')
          .update(
            [
              conversationId,
              senderId,
              type,
              fileData?.fileUrl || '',
              content || '',
              Math.floor(Date.now() / AUTO_IDEMPOTENCY_WINDOW_MS),
            ].join('|'),
          )
          .digest('hex');

    const dup = await this.messages.findOne({ where: { idempotencyKey: effectiveKey } });
    if (dup) return this.view(dup);

    const conversation = await this.conversationForMember(conversationId, orgId, senderId);

    // Reject messages to archived conversations.
    if (conversation.isArchived) {
      throw new BadRequestException('Cannot send messages to archived conversation');
    }

    // Enforce whoCanPost on channels.
    if (conversation.type === 'channel' && conversation.settings?.whoCanPost === 'admins') {
      const me = conversation.participants.find((p) => p.userId === senderId);
      if (me?.role !== 'admin' && me?.role !== 'owner') {
        throw new ForbiddenException('Only admins can post in this channel');
      }
    }

    const sanitizedContent = content ? sanitizeHtml(content) : '';
    const contentPlainText = sanitizedContent ? toPlainText(sanitizedContent) : '';

    // Reject whitespace-only text messages.
    if (contentPlainText.trim().length === 0 && type === 'text') {
      throw new BadRequestException('Message cannot be empty');
    }

    // Normalise the incoming FE↔BE mention contract into the stored entity shape.
    const storedMentions: Mention[] = (mentions ?? [])
      .filter((m) => m && (m.type === 'user' || m.type === 'here' || m.type === 'all'))
      .map((m) => ({
        type: m.type,
        targetId: m.targetId ?? '',
        displayName: null,
        offset: 0,
        length: 0,
      }));

    const nowIso = new Date().toISOString();
    const entity = this.messages.create({
      conversationId,
      organizationId: conversation.organizationId,
      senderId,
      senderName: senderName || null,
      content: sanitizedContent,
      contentPlainText,
      type,
      replyTo: replyTo || null,
      forwardedFrom: forwardedFrom ?? null,
      idempotencyKey: effectiveKey,
      status: 'sent',
      readBy: [{ userId: senderId, readAt: nowIso }],
      mentions: storedMentions,
      fileUrl: fileData?.fileUrl ?? null,
      fileName: fileData?.fileName ?? null,
      fileSize: fileData?.fileSize ?? null,
      fileMimeType: fileData?.fileMimeType ?? null,
      fileId: fileData?.fileId ?? null,
    });

    let saved: MessageEntity;
    try {
      saved = await this.messages.save(entity);
    } catch (err: any) {
      // Two concurrent identical sends raced past the findOne check — the
      // partial-unique index rejects the loser. Return the winner.
      if (this.isUniqueViolation(err)) {
        const winner = await this.messages.findOne({ where: { idempotencyKey: effectiveKey } });
        if (winner) return this.view(winner);
      }
      throw err;
    }

    await this.conversationsService.updateLastMessage(conversationId, saved);

    const viewed = this.view(saved);
    // Broadcast the new message to the conversation room (live delivery). Routed
    // through the event bus so this service never depends on the socket gateway.
    this.safeEmit(CHAT_MESSAGE_NEW, { conversationId, message: viewed });

    // Fire mention notifications. Best-effort: a notification failure must NEVER
    // fail the message send. Recipients are resolved strictly from THIS
    // conversation's participants, so a mention can't leak across conversations.
    await this.notifyMentions(conversation, saved, storedMentions, senderId, senderName);

    return viewed;
  }

  /**
   * Expand a message's mentions to the de-duplicated set of recipient userIds,
   * EXCLUDING the sender:
   *   - `user`  → that userId, but ONLY if they are a participant of the
   *               conversation (non-participants are ignored).
   *   - `here` / `all` → every participant except the sender (no presence in v1,
   *               so `here` == every participant).
   */
  resolveMentionRecipients(
    conversation: ConversationEntity,
    mentions: Mention[] | undefined,
    senderId: string,
  ): string[] {
    if (!mentions?.length) return [];
    const participantIds = new Set(
      (conversation.participants ?? []).map((p) => p.userId),
    );
    const recipients = new Set<string>();
    for (const m of mentions) {
      if (m.type === 'here' || m.type === 'all') {
        for (const id of participantIds) recipients.add(id);
      } else if (m.type === 'user') {
        if (participantIds.has(m.targetId)) recipients.add(m.targetId);
      }
    }
    recipients.delete(senderId);
    return [...recipients];
  }

  /** Emit a `chat_mention` notification per resolved recipient. Fail-safe. */
  private async notifyMentions(
    conversation: ConversationEntity,
    message: MessageEntity,
    mentions: Mention[],
    senderId: string,
    senderName?: string,
  ): Promise<void> {
    try {
      const recipients = this.resolveMentionRecipients(conversation, mentions, senderId);
      if (!recipients.length) return;
      const who = senderName || 'Someone';
      const where = conversation.name ? `#${conversation.name}` : 'a conversation';
      for (const userId of recipients) {
        // Away-gated: an actively-online recipient sees the mention live in the
        // open conversation, so skip the notification. Only away/offline/
        // on-holiday recipients get notified. Fail-safe — a presence lookup
        // error means we notify (better a redundant ping than a missed one).
        try {
          if (this.presence.isOnline(userId)) continue;
        } catch {
          /* fall through and notify */
        }
        await this.notifier.notify({
          organizationId: conversation.organizationId || '',
          userId,
          actorId: senderId,
          type: 'chat_mention',
          title: `${who} mentioned you`,
          body: message.contentPlainText || `${who} mentioned you in ${where}.`,
          data: {
            actionUrl: `/chat?conversation=${conversation.id}`,
            conversationId: conversation.id,
            messageId: message.id,
          },
        });
      }
    } catch (err) {
      // Never let a notification failure break the send.
      this.logger.error(`notifyMentions failed (conv=${conversation.id}): ${String(err)}`);
    }
  }

  private isUniqueViolation(err: any): boolean {
    // Postgres unique_violation.
    return err?.code === '23505';
  }

  // ── list ────────────────────────────────────────────────────────────────

  async getMessages(
    conversationId: string,
    orgId: string,
    userId: string,
    page = 1,
    limit = 50,
    order: 'asc' | 'desc' = 'asc',
  ) {
    await this.conversationForMember(conversationId, orgId, userId);

    const safeLimit = Math.min(limit || 50, 200);
    const safePage = Math.max(page || 1, 1);
    const skip = (safePage - 1) * safeLimit;
    const sortDir = order === 'desc' ? 'DESC' : 'ASC';

    const [rows, total] = await this.messages.findAndCount({
      where: { conversationId, isDeleted: false, threadId: IsNull() },
      order: { createdAt: sortDir },
      skip,
      take: safeLimit,
    });

    return {
      data: rows.map((m) => this.view(m)),
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        pages: Math.ceil(total / safeLimit),
      },
    };
  }

  // ── edit / delete ─────────────────────────────────────────────────────────

  async editMessage(messageId: string, orgId: string, senderId: string, newContent: string) {
    const message = await this.messages.findOne({ where: { id: messageId, isDeleted: false } });
    if (!message) throw new NotFoundException('Message not found');
    // Org-scope + participant check via the parent conversation.
    await this.conversationForMember(message.conversationId, orgId, senderId);
    if (message.senderId !== senderId) {
      throw new ForbiddenException('Can only edit your own messages');
    }

    const sanitizedContent = newContent ? sanitizeHtml(newContent) : '';
    message.editHistory = [
      ...message.editHistory,
      { content: message.content, editedAt: new Date().toISOString() },
    ];
    message.content = sanitizedContent;
    message.contentPlainText = sanitizedContent ? toPlainText(sanitizedContent) : '';
    message.isEdited = true;
    message.editedAt = new Date();
    const saved = await this.messages.save(message);
    const viewed = this.view(saved);
    this.safeEmit(CHAT_MESSAGE_UPDATED, {
      conversationId: saved.conversationId,
      message: viewed,
    });
    return viewed;
  }

  async deleteMessage(messageId: string, orgId: string, userId: string) {
    const message = await this.messages.findOne({ where: { id: messageId, isDeleted: false } });
    if (!message) throw new NotFoundException('Message not found');
    const conversation = await this.conversationForMember(message.conversationId, orgId, userId);

    // A user may delete their own message; a channel owner/admin may delete any
    // message in that channel (moderation).
    const isOwn = message.senderId === userId;
    const requester = conversation.participants.find((p) => p.userId === userId);
    const isModerator = !!requester && (requester.role === 'owner' || requester.role === 'admin');
    if (!isOwn && !isModerator) {
      throw new ForbiddenException('Can only delete your own messages');
    }

    message.isDeleted = true;
    message.deletedAt = new Date();
    message.deletedBy = userId;
    await this.messages.save(message);
    this.safeEmit(CHAT_MESSAGE_DELETED, {
      conversationId: message.conversationId,
      messageId: message.id,
    });
    return { message: 'Message deleted successfully' };
  }

  // ── read / delivery ────────────────────────────────────────────────────────

  async markAsRead(conversationId: string, orgId: string, userId: string) {
    await this.conversationForMember(conversationId, orgId, userId);
    await this.conversationsService.markAsRead(conversationId, userId);

    // Append a read receipt for this user to every message they haven't read,
    // and flip other senders' messages to 'read'. jsonb has no server-side
    // array-append predicate we can lean on here, so we do it in a scoped pass.
    const rows = await this.messages.find({
      where: { conversationId, isDeleted: false },
    });
    const nowIso = new Date().toISOString();
    const toSave: MessageEntity[] = [];
    for (const m of rows) {
      let changed = false;
      if (!m.readBy.some((r) => r.userId === userId)) {
        m.readBy = [...m.readBy, { userId, readAt: nowIso }];
        changed = true;
      }
      if (m.senderId !== userId && (m.status === 'sent' || m.status === 'delivered')) {
        m.status = 'read';
        changed = true;
      }
      if (changed) toSave.push(m);
    }
    if (toSave.length) await this.messages.save(toSave);
    return { message: 'Marked as read' };
  }

  // ── reactions ─────────────────────────────────────────────────────────────

  async addReaction(messageId: string, orgId: string, userId: string, emoji: string) {
    const message = await this.messages.findOne({ where: { id: messageId, isDeleted: false } });
    if (!message) throw new NotFoundException('Message not found');
    await this.conversationForMember(message.conversationId, orgId, userId);

    const reactions: ReactionGroup[] = message.reactions ?? [];
    // One reaction per user per message (Teams-style): same emoji toggles off,
    // a different emoji moves the user's reaction rather than stacking.
    const alreadyThisEmoji = reactions.some(
      (r) => r.emoji === emoji && r.users.some((u) => u.userId === userId),
    );
    for (const r of reactions) {
      const idx = r.users.findIndex((u) => u.userId === userId);
      if (idx >= 0) {
        r.users.splice(idx, 1);
        r.count = r.users.length;
      }
    }
    let next = reactions.filter((r) => (r.count ?? r.users.length) > 0);
    if (!alreadyThisEmoji) {
      const existing = next.find((r) => r.emoji === emoji);
      if (existing) {
        existing.users.push({ userId, createdAt: new Date().toISOString() });
        existing.count = existing.users.length;
      } else {
        next = [...next, { emoji, users: [{ userId, createdAt: new Date().toISOString() }], count: 1 }];
      }
    }
    message.reactions = next;
    const saved = await this.messages.save(message);
    return this.view(saved);
  }

  // ── search / counts ─────────────────────────────────────────────────────────

  async searchMessages(conversationId: string, orgId: string, query: string, userId: string) {
    await this.conversationForMember(conversationId, orgId, userId);
    const rows = await this.messages
      .createQueryBuilder('m')
      .where('m.conversation_id = :conversationId', { conversationId })
      .andWhere('m.is_deleted = false')
      .andWhere('m.content ILIKE :q', { q: `%${query}%` })
      .orderBy('m.created_at', 'DESC')
      .limit(50)
      .getMany();
    return rows.map((m) => this.view(m));
  }

  /**
   * App-wide unread badge: for every conversation the user is in, count
   * messages from OTHER senders newer than the user's lastReadAt.
   */
  async getUnreadCount(userId: string, orgId: string) {
    const convs = await this.conversations
      .createQueryBuilder('c')
      .where('c.is_deleted = false')
      .andWhere('c.organization_id = :orgId', { orgId })
      .andWhere(':me = ANY(c.participant_ids)', { me: userId })
      .getMany();

    let unreadConversations = 0;
    let unreadMessages = 0;
    for (const c of convs) {
      const me = c.participants.find((p) => p.userId === userId);
      const since = me?.lastReadAt ? new Date(me.lastReadAt) : new Date(0);
      const n = await this.messages
        .createQueryBuilder('m')
        .where('m.conversation_id = :cid', { cid: c.id })
        .andWhere('m.is_deleted = false')
        .andWhere('m.sender_id != :me', { me: userId })
        .andWhere('m.created_at > :since', { since })
        .getCount();
      if (n > 0) {
        unreadConversations += 1;
        unreadMessages += n;
      }
    }
    // `count` kept for back-compat (was "conversations with unread").
    return { unreadConversations, unreadMessages, count: unreadConversations };
  }

  async getReadStatus(conversationId: string, orgId: string, messageId: string, userId: string) {
    const conversation = await this.conversationForMember(conversationId, orgId, userId);
    const message = await this.messages.findOne({ where: { id: messageId, conversationId } });
    if (!message) throw new NotFoundException('Message not found');

    const totalParticipants = conversation.participants.length;
    const readCount = message.readBy?.length ?? 0;
    const readBy =
      conversation.type !== 'channel'
        ? (message.readBy ?? []).map((r) => ({ userId: r.userId, readAt: r.readAt }))
        : [];
    return { totalParticipants, readCount, readBy };
  }

  // ── pin / unpin ───────────────────────────────────────────────────────────

  /** Load a non-deleted message, enforcing same-org + participant on its parent. */
  private async messageForMember(
    messageId: string,
    orgId: string,
    userId: string,
  ): Promise<MessageEntity> {
    const message = await this.messages.findOne({ where: { id: messageId, isDeleted: false } });
    if (!message) throw new NotFoundException('Message not found');
    await this.conversationForMember(message.conversationId, orgId, userId);
    return message;
  }

  /** Pin a message (participant-only). Emits `chat.message.updated`. */
  async pinMessage(messageId: string, orgId: string, userId: string) {
    const message = await this.messageForMember(messageId, orgId, userId);
    message.isPinned = true;
    message.pinnedBy = userId;
    message.pinnedAt = new Date();
    const saved = await this.messages.save(message);
    const viewed = this.view(saved);
    this.safeEmit(CHAT_MESSAGE_UPDATED, { conversationId: saved.conversationId, message: viewed });
    return viewed;
  }

  /** Unpin a message (participant-only). Emits `chat.message.updated`. */
  async unpinMessage(messageId: string, orgId: string, userId: string) {
    const message = await this.messageForMember(messageId, orgId, userId);
    message.isPinned = false;
    message.pinnedBy = null;
    message.pinnedAt = null;
    const saved = await this.messages.save(message);
    const viewed = this.view(saved);
    this.safeEmit(CHAT_MESSAGE_UPDATED, { conversationId: saved.conversationId, message: viewed });
    return viewed;
  }

  /** The conversation's pinned messages, newest-pinned first (participant-only). */
  async getPinnedMessages(conversationId: string, orgId: string, userId: string) {
    await this.conversationForMember(conversationId, orgId, userId);
    const rows = await this.messages.find({
      where: { conversationId, isPinned: true, isDeleted: false },
      order: { pinnedAt: 'DESC' },
    });
    return rows.map((m) => this.view(m));
  }

  // ── forward ───────────────────────────────────────────────────────────────

  /**
   * Forward a message into one or more conversations. For every target the
   * caller is a participant of (same org), a NEW `forwarded` message is created
   * via the normal send path — so idempotency + the `chat.message.new` emit both
   * happen. Targets the caller isn't a participant of (or cross-org) are SKIPPED
   * silently — we never leak whether such a conversation exists. Returns the
   * created forwarded messages.
   */
  async forwardMessage(
    messageId: string,
    orgId: string,
    userId: string,
    conversationIds: string[],
    senderName?: string,
  ) {
    // The caller must be a participant of the SOURCE conversation to forward.
    const original = await this.messages.findOne({
      where: { id: messageId, isDeleted: false },
    });
    if (!original) throw new NotFoundException('Message not found');
    const source = await this.conversationForMember(original.conversationId, orgId, userId);

    const forwardedFrom: Record<string, unknown> = {
      messageId: original.id,
      conversationId: original.conversationId,
      conversationName: source.name ?? null,
      senderId: original.senderId,
      senderName: original.senderName ?? null,
      content: original.content ?? '',
    };

    const fileData =
      original.fileUrl || original.fileId
        ? {
            fileUrl: original.fileUrl ?? undefined,
            fileName: original.fileName ?? undefined,
            fileSize: original.fileSize ?? undefined,
            fileMimeType: original.fileMimeType ?? undefined,
            fileId: original.fileId ?? undefined,
          }
        : undefined;

    const uniqueTargets = [...new Set(conversationIds ?? [])];
    const created: Record<string, unknown>[] = [];
    for (const targetId of uniqueTargets) {
      // Silently skip a target the caller isn't in (or that's cross-org / gone) —
      // don't leak its existence, and don't fail the whole forward.
      try {
        await this.conversationForMember(targetId, orgId, userId);
      } catch {
        continue;
      }
      try {
        const msg = await this.sendMessage(
          targetId,
          orgId,
          userId,
          original.content ?? '',
          'forwarded',
          undefined,
          senderName,
          fileData,
          undefined,
          undefined,
          forwardedFrom,
        );
        created.push(msg);
      } catch (err) {
        // A per-target send failure (e.g. archived target) must not abort the
        // rest of the batch — skip it and continue.
        this.logger.warn(`forward to ${targetId} failed: ${String(err)}`);
      }
    }
    return created;
  }
}
