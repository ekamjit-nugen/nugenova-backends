import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * ChatBookmark — a per-user "saved message" store. Ported from the legacy Mongo
 * chat-service `bookmarks` collection. A bookmark is private to the user who
 * created it: only the owner ever reads or removes it.
 *
 * Shape decisions for the Postgres port:
 * - `organizationId` is denormalised from the parent message's conversation so a
 *   bookmark read can be org-scoped without a join. Every read/write is scoped
 *   to `organizationId` AND `userId` (tenant + user isolation).
 * - A PARTIAL-free composite UNIQUE index on `(userId, messageId)` makes save
 *   idempotent — a user can bookmark a given message at most once; a repeat save
 *   is a no-op that returns the existing row (the Postgres equivalent of the
 *   Mongo unique compound index).
 */
@Entity('chat_bookmarks')
@Index('ix_chat_bookmark_user', ['userId'])
@Index('ux_chat_bookmark_user_msg', ['userId', 'messageId'], { unique: true })
export class ChatBookmarkEntity extends PgBaseEntity {
  /** Denormalised owning org (copied from the message's conversation on save). */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  organizationId: string | null;

  /** The owning user — a bookmark is private to them. */
  @Column({ type: 'varchar', length: 24 })
  userId: string;

  /** The saved message. */
  @Column({ type: 'varchar', length: 24 })
  messageId: string;

  /** Denormalised parent conversation of the saved message. */
  @Column({ type: 'varchar', length: 24 })
  conversationId: string;
}
