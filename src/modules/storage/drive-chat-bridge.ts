import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { DriveService } from './drive.service';
import {
  CHAT_MESSAGE_NEW,
  ChatMessageEvent,
} from '../chat/realtime/chat-events';

/**
 * Live bridge: when a chat message with an attachment is sent, index that
 * attachment into Cloud Drive so files shared in chat show up in the drive
 * without a byte copy. The service routes by conversation — a DM attachment
 * lands in each participant's My Drive, a group/channel attachment in Team
 * Drive.
 *
 * Listens on the same in-process `EventEmitter2` bus the chat gateway uses
 * (CHAT_MESSAGE_NEW), so chat stays fully decoupled from the drive — it emits,
 * we react. Fire-and-forget and swallow errors: a bridge hiccup must never
 * affect message delivery. Bridging is idempotent per (storageFileId, scope,
 * owner), so a message re-delivery (or a later backfill) never double-indexes.
 */
@Injectable()
export class DriveChatBridge {
  private readonly log = new Logger(DriveChatBridge.name);

  constructor(private readonly drive: DriveService) {}

  @OnEvent(CHAT_MESSAGE_NEW, { async: true })
  async onMessageNew(payload: ChatMessageEvent): Promise<void> {
    try {
      const msg = (payload?.message ?? {}) as Record<string, unknown>;
      const organizationId = msg.organizationId as string | undefined;
      const conversationId =
        (msg.conversationId as string | undefined) ?? payload?.conversationId;
      if (!organizationId || !conversationId) return;

      // Flat attachment field + the rich `attachments[]` array both carry a
      // fileId; collect every distinct one referenced by this message.
      const ids = new Set<string>();
      if (typeof msg.fileId === 'string' && msg.fileId) ids.add(msg.fileId);
      const attachments = Array.isArray(msg.attachments)
        ? (msg.attachments as Array<Record<string, unknown>>)
        : [];
      for (const a of attachments) {
        if (typeof a?.fileId === 'string' && a.fileId) ids.add(a.fileId);
      }
      if (!ids.size) return;

      // The service resolves the conversation and routes DM → My Drive /
      // group → Team Drive.
      await this.drive.bridgeChatMessage({
        organizationId,
        conversationId,
        fileIds: [...ids],
      });
    } catch (err) {
      this.log.warn(
        `chat→drive bridge skipped a message: ${(err as Error)?.message}`,
      );
    }
  }
}
