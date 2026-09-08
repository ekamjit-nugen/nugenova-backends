import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/** Job lifecycle. queued → running → done|error. */
export type AiJobStatus = 'queued' | 'running' | 'done' | 'error';

/** What kind of background work this job performs. Only 'chat' today. */
export type AiJobKind = 'chat';

/**
 * AiJob — a DB-backed background job row.
 *
 * The platform has no Redis/BullMQ, so async AI work is modelled as a row here +
 * in-process execution (queueMicrotask/setImmediate, NOT awaited in the request
 * — see AiJobService). The row is the durable record of a unit of work: the
 * worker marks it `running`, does the work, then `done(result)` or
 * `error(errorMessage)`.
 *
 * RESTART SEAM: because execution is in-process, a process crash/restart leaves
 * any `queued`/`running` row ORPHANED (no worker will ever finish it). On module
 * init AiJobService sweeps rows older than ~10 min still in those states to
 * `error('interrupted')` so clients polling them stop waiting. A multi-node or
 * durable-queue deployment would replace this with a real broker.
 */
@Entity('ai_jobs')
@Index('ix_ai_jobs_org_user', ['organizationId', 'userId'])
@Index('ix_ai_jobs_status_created', ['status', 'createdAt'])
export class AiJobEntity extends PgBaseEntity {
  /** Owning org — the tenant boundary. Always set from req.user on submit. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  organizationId: string | null;

  /** Who submitted it. Always set from req.user. */
  @Column({ type: 'varchar', length: 24 })
  userId: string;

  @Column({ type: 'varchar', default: 'chat' })
  kind: AiJobKind;

  @Column({ type: 'varchar', default: 'queued' })
  status: AiJobStatus;

  /** The work input (e.g. { conversationId, userMessageId, assistantMessageId }). */
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  input: Record<string, unknown>;

  /** The work output once done (e.g. { grounded, sourceCount }). Null until then. */
  @Column({ type: 'jsonb', nullable: true, default: null })
  result: Record<string, unknown> | null;

  /** Populated when status='error'. */
  @Column({ type: 'text', nullable: true, default: null })
  errorMessage: string | null;

  /** Set when the worker reaches a terminal state (done|error). */
  @Column({ type: 'timestamptz', nullable: true, default: null })
  completedAt: Date | null;
}
