import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * One row per org tracking the activity-log retention job: when it last archived
 * + purged, and an in-progress lock. The lock (`lockedAt`) is claimed with a
 * conditional UPDATE so the destructive 15-day job runs at most once per org
 * even if the cron fires on multiple app instances (the codebase has no other
 * distributed lock).
 */
@Entity('activity_retention_runs')
@Index('uq_activity_retention_org', ['organizationId'], { unique: true })
export class ActivityRetentionRunEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  /** When the last successful archive+purge completed. */
  @Column({ type: 'timestamptz', nullable: true, default: null })
  lastRunAt: Date | null;

  /** Set while a run is in flight; cleared when it finishes. Stale locks expire. */
  @Column({ type: 'timestamptz', nullable: true, default: null })
  lockedAt: Date | null;

  /** Rows archived + deleted in the last run (for observability). */
  @Column({ type: 'int', default: 0 })
  lastArchivedCount: number;
}
