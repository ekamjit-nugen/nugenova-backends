import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * One participant in a conversation. Stored inside the `participants` jsonb
 * array (mirrors the Mongo sub-document). Their display name is NOT stored
 * here — it is resolved from the auth `users` table on read (see
 * ConversationsService.enrich*).
 */
export interface Participant {
  userId: string;
  role: string; // owner | admin | member
  memberStatus: string; // active | invited | pending
  joinedAt: string; // ISO — jsonb has no Date type
  /**
   * When set (ISO), this member only sees messages sent at/after this time — used
   * when they were added WITHOUT sharing prior history. Null/undefined = full
   * history (the default for the group's original members).
   */
  historyFrom?: string | null;
  lastReadAt: string; // ISO
  lastReadMessageId?: string | null;
  muted: boolean;
  mutedUntil?: string | null;
  isPinned?: boolean;
  isStarred?: boolean;
  notifyPreference?: string; // all | mentions | nothing
}

/** Compact denormalised copy of the most recent message, for the list view. */
export interface LastMessage {
  _id?: string | null;
  content: string | null;
  senderId: string | null;
  senderName?: string | null;
  type?: string | null;
  sentAt: string | null; // ISO
}

/** Channel posting/mention/pin restrictions (jsonb). */
export interface ChannelSettings {
  whoCanPost?: string | null;
  whoCanMention?: string | null;
  whoCanPin?: string | null;
  threadRequirement?: string | null;
  slowModeSeconds?: number;
  autoArchiveDays?: number;
}

/**
 * ChatConversation — a direct message, group, channel, meeting chat or
 * notes-to-self thread. Ported from the legacy Mongo `conversations`
 * collection (chat-service).
 *
 * Shape decisions for the Postgres port:
 * - `participants` and `lastMessage`/`settings` are jsonb (mirroring the Mongo
 *   embedded docs). Dates inside jsonb are stored as ISO strings.
 * - `participantIds` is a denormalised `text[]` kept in lock-step with
 *   `participants[].userId`. It carries a GIN index so the hot "conversations
 *   I'm a participant of" query (`:me = ANY(participant_ids)`) is index-served
 *   — the Postgres equivalent of the Mongo `participants.userId` index.
 * - Every read/write is scoped to `organizationId` AND the caller's userId, so
 *   no user ever sees another org's or another user's conversations.
 */
@Entity('chat_conversations')
@Index('ix_chat_conv_org', ['organizationId'])
@Index('ix_chat_conv_participant_ids', ['participantIds']) // GIN — see migration
@Index('ix_chat_conv_org_channeltype', ['organizationId', 'channelType'])
export class ConversationEntity extends PgBaseEntity {
  /** Owning org. Always set from req.user on create — the tenant boundary. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  organizationId: string | null;

  /** direct | group | channel | meeting_chat | self */
  @Column({ type: 'varchar', default: 'direct' })
  type: string;

  /** public | private | announcement | shared (channels only). */
  @Column({ type: 'varchar', nullable: true, default: null })
  channelType: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  name: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  description: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  avatar: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  icon: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  topic: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  categoryId: string | null;

  /** Set on the one admin-managed "Client · <company>" channel per client. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  clientId: string | null;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  participants: Participant[];

  /**
   * Denormalised participant user ids, kept in sync with `participants`. Enables
   * the index-served membership filter (`:me = ANY(participant_ids)`).
   */
  @Column({ type: 'text', array: true, default: () => "'{}'::text[]" })
  participantIds: string[];

  @Column({ type: 'jsonb', nullable: true, default: null })
  lastMessage: LastMessage | null;

  @Column({ type: 'int', default: 0 })
  messageCount: number;

  @Column({ type: 'jsonb', nullable: true, default: null })
  settings: ChannelSettings | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  meetingId: string | null;

  @Column({ type: 'boolean', default: false })
  isArchived: boolean;

  @Column({ type: 'varchar', length: 24 })
  createdBy: string;

  @Column({ type: 'boolean', default: false })
  isDeleted: boolean;
}
