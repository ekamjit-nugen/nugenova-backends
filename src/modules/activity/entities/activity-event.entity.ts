import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * The high-level bucket an activity belongs to — the dimension the UI filters
 * on. Stored as plain text (no enum type) so adding a value is code-only.
 */
export type ActivityCategory =
  | 'auth'
  | 'attendance'
  | 'leave'
  | 'meetings'
  | 'files'
  | 'boards'
  | 'ai'
  | 'onboarding'
  | 'settings'
  | 'recruitment'
  | 'other';

/**
 * One row per meaningful thing a member did — the unified activity feed.
 *
 * This is a CURATED domain-event log (login, leave applied, meeting created, a
 * file uploaded, an AI call, …), not a raw per-request audit. Writers call
 * {@link ActivityService.record} at the choke points; the feed reads back by
 * org/actor/category/time.
 *
 * Rows are subject to the 15-day retention job (zipped to the org owner then
 * deleted) — this table is the "logs" that age out. AI-usage METRICS live in
 * `ai_usage_events` and are NOT purged; only the lightweight `ai.used` activity
 * row here ages out.
 */
@Entity('activity_events')
@Index('ix_activity_org_created', ['organizationId', 'createdAt'])
@Index('ix_activity_org_actor_created', ['organizationId', 'actorId', 'createdAt'])
@Index('ix_activity_org_category_created', ['organizationId', 'category', 'createdAt'])
export class ActivityEventEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  /** Auth userId of the person who acted. Null for system-generated activity. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  actorId: string | null;

  /** Denormalised display name, so the feed renders without a users join. */
  @Column({ type: 'varchar', nullable: true, default: null })
  actorName: string | null;

  /** Dotted machine action, e.g. `leave.applied`, `meeting.created`, `ai.used`. */
  @Column({ type: 'varchar' })
  action: string;

  @Column({ type: 'varchar', default: 'other' })
  category: ActivityCategory;

  /** What the action was about, e.g. `meeting` / `leave_request` / `file`. */
  @Column({ type: 'varchar', nullable: true, default: null })
  targetType: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  targetId: string | null;

  /** Human-readable one-liner shown in the feed. */
  @Column({ type: 'varchar', nullable: true, default: null })
  summary: string | null;

  @Column({ type: 'jsonb', nullable: false, default: () => `'{}'::jsonb` })
  metadata: Record<string, unknown>;

  @Column({ type: 'varchar', nullable: true, default: null })
  ip: string | null;
}
