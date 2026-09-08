import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * Per-scope storage quota LIMIT for the Cloud Drive.
 *
 * One row per limit target:
 *   - `ownerId = null`  → the org Team-Drive pool limit.
 *   - `ownerId = <uid>` → that user's My-Drive limit override.
 *
 * The LIMIT lives here; USED bytes are always computed live by summing
 * `drive_files.size` for the matching scope (never denormalised, so it can't
 * drift). When no row exists the service applies the built-in defaults
 * (`DEFAULT_TEAM_QUOTA_GB` / `DEFAULT_USER_QUOTA_GB`).
 *
 * This deliberately keeps quota inside the drive module rather than mutating the
 * shared `organizations` row — a cleaner module boundary than the legacy
 * `org.storage.quotaGb` sub-document.
 */
@Entity('drive_quotas')
@Index('ux_drive_quota_scope', ['organizationId', 'ownerId'], {
  unique: true,
  where: `"owner_id" IS NOT NULL`,
})
@Index('ux_drive_quota_team', ['organizationId'], {
  unique: true,
  where: `"owner_id" IS NULL`,
})
export class DriveQuotaEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  /** null = the org Team-Drive pool; otherwise a per-user My-Drive override. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  ownerId: string | null;

  /** The quota ceiling in bytes. */
  @Column({ type: 'bigint', default: 0 })
  limitBytes: string;

  /**
   * Org-wide default My-Drive ceiling in bytes. Only meaningful on the team-pool
   * row (`ownerId = null`); ignored on per-user override rows. Null → fall back
   * to the built-in `DEFAULT_USER_QUOTA_GB`.
   */
  @Column({ type: 'bigint', nullable: true, default: null })
  defaultUserLimitBytes: string | null;
}
