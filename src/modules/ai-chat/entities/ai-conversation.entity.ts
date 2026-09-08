import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * AiConversation — one multi-turn AI chatbot thread owned by a single user.
 *
 * Unlike the person-to-person `chat_conversations` (which has a participant
 * array), an AI conversation has exactly one human owner (`userId`) talking to
 * the assistant, so isolation is a flat `(organizationId, userId)` filter — a
 * user only ever sees their OWN threads, and never another tenant's.
 *
 * `lastMessageAt` is bumped on every send so the list view can order
 * newest-first without scanning `ai_messages`.
 */
@Entity('ai_conversations')
@Index('ix_ai_conversations_org_user', ['organizationId', 'userId'])
export class AiConversationEntity extends PgBaseEntity {
  /** Owning org — the tenant boundary. Always set from req.user on create. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  organizationId: string | null;

  /** The single human owner of this thread. Always set from req.user. */
  @Column({ type: 'varchar', length: 24 })
  userId: string;

  /** Display title. Null until set explicitly or auto-titled from the first message. */
  @Column({ type: 'varchar', nullable: true, default: null })
  title: string | null;

  /** Bumped to now() on every user/assistant message — drives the newest-first list. */
  @Column({ type: 'timestamptz', nullable: true, default: null })
  lastMessageAt: Date | null;
}
