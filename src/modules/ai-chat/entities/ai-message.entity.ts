import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/** A cited source on a grounded assistant answer (mirrors knowledge AnswerSource). */
export interface AiMessageSource {
  sourceId: string;
  sourceName: string;
  chunkIndex: number;
}

/** Lifecycle of an assistant message produced by the async worker. */
export type AiMessageStatus = 'pending' | 'done' | 'error';

/**
 * AiMessage — one turn in an {@link AiConversationEntity}.
 *
 * A `user` message is persisted complete and immediately. An `assistant`
 * message is created as a PENDING placeholder the instant the user sends (so the
 * client has an id to poll), then filled in by the background worker:
 * `content`/`sources`/`grounded` land and `status` flips `pending → done`, or
 * `status → error` with `errorMessage` on failure.
 *
 * `organizationId` is denormalised from the parent conversation so a message
 * read is org-scoped without a join (defence in depth — the conversation's
 * `userId` check is still the primary gate). `jobId` links to the
 * {@link AiJobEntity} that (re)produces an assistant turn.
 */
@Entity('ai_messages')
@Index('ix_ai_messages_conv_created', ['conversationId', 'createdAt'])
export class AiMessageEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  conversationId: string;

  /** Denormalised owning org (copied from the conversation). The tenant boundary. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  organizationId: string | null;

  /** 'user' | 'assistant'. (No 'system' — the grounding block is built per-call.) */
  @Column({ type: 'varchar', default: 'user' })
  role: 'user' | 'assistant';

  @Column({ type: 'text', default: '' })
  content: string;

  /** Cited grounding sources (assistant only). Empty array when ungrounded. */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  sources: AiMessageSource[];

  /** True when the answer was grounded in retrieved org chunks (assistant only). */
  @Column({ type: 'boolean', default: false })
  grounded: boolean;

  /** Assistant lifecycle: 'pending' until the worker completes. 'done' for user turns. */
  @Column({ type: 'varchar', default: 'done' })
  status: AiMessageStatus;

  /** Populated when status='error' — a safe, user-facing failure reason. */
  @Column({ type: 'text', nullable: true, default: null })
  errorMessage: string | null;

  /** The AiJob that produces/produced this assistant turn (null for user turns). */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  jobId: string | null;
}
