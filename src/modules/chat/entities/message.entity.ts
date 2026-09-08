import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/** A user's reaction membership inside a ReactionGroup. */
export interface ReactionUser {
  userId: string;
  createdAt: string; // ISO
}

/** One emoji's reaction group on a message (jsonb). */
export interface ReactionGroup {
  emoji: string;
  users: ReactionUser[];
  count: number;
}

/** @mention span inside message content (jsonb). */
export interface Mention {
  type: string; // user | channel | here | all
  targetId: string;
  displayName?: string | null;
  offset: number;
  length: number;
}

/** A file/media attachment (jsonb). */
export interface Attachment {
  fileId?: string | null;
  name: string;
  url: string;
  thumbnailUrl?: string | null;
  type: string;
  mimeType?: string | null;
  size: number;
}

/** A per-user read receipt (jsonb). */
export interface ReadReceipt {
  userId: string;
  readAt: string; // ISO
}

/** A per-user delivery receipt (jsonb). */
export interface DeliveryReceipt {
  userId: string;
  deliveredAt: string; // ISO
}

/** One prior version of an edited message (jsonb). */
export interface EditHistoryEntry {
  content: string;
  editedAt: string; // ISO
}

/**
 * ChatMessage — a single message in a conversation. Ported from the legacy
 * Mongo `messages` collection (chat-service).
 *
 * Shape decisions for the Postgres port:
 * - The rich embedded arrays (reactions, mentions, attachments, readBy,
 *   deliveredTo, editHistory) map to jsonb columns; Dates inside jsonb are ISO
 *   strings.
 * - `organizationId` is denormalised from the parent conversation so a message
 *   read can be org-scoped without a join (defence in depth — the parent
 *   conversation's participant check is still the primary gate).
 * - `idempotencyKey` carries a PARTIAL UNIQUE index (WHERE key IS NOT NULL),
 *   the Postgres equivalent of the Mongo sparse-unique index — it makes the
 *   double-send de-dupe race-safe.
 */
@Entity('chat_messages')
@Index('ix_chat_msg_conv_created', ['conversationId', 'createdAt'])
@Index('ix_chat_msg_conv_deleted', ['conversationId', 'isDeleted'])
@Index('ix_chat_msg_sender', ['senderId'])
export class MessageEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  conversationId: string;

  /** Denormalised owning org (copied from the conversation on send). */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  organizationId: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  threadId: string | null;

  @Column({ type: 'varchar', length: 24 })
  senderId: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  senderName: string | null;

  @Column({ type: 'text', default: '' })
  content: string;

  @Column({ type: 'text', nullable: true, default: null })
  contentPlainText: string | null;

  /** text | file | image | video | audio | code | poll | card | meeting | call | forwarded | system | standup */
  @Column({ type: 'varchar', default: 'text' })
  type: string;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  replyTo: string | null;

  /** Client-supplied or auto-derived key; partial-unique index de-dupes sends. */
  @Column({ type: 'varchar', nullable: true, default: null })
  idempotencyKey: string | null;

  /** sending | sent | delivered | read | failed */
  @Column({ type: 'varchar', default: 'sent' })
  status: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  fileUrl: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  fileName: string | null;

  @Column({ type: 'int', nullable: true, default: null })
  fileSize: number | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  fileMimeType: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  fileId: string | null;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  deliveredTo: DeliveryReceipt[];

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  attachments: Attachment[];

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  mentions: Mention[];

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  reactions: ReactionGroup[];

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  readBy: ReadReceipt[];

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  editHistory: EditHistoryEntry[];

  @Column({ type: 'jsonb', nullable: true, default: null })
  forwardedFrom: Record<string, unknown> | null;

  @Column({ type: 'boolean', default: false })
  isEdited: boolean;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  editedAt: Date | null;

  @Column({ type: 'boolean', default: false })
  isDeleted: boolean;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  deletedAt: Date | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  deletedBy: string | null;

  @Column({ type: 'boolean', default: false })
  isPinned: boolean;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  pinnedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  pinnedAt: Date | null;

  /** normal | urgent */
  @Column({ type: 'varchar', default: 'normal' })
  priority: string;
}
