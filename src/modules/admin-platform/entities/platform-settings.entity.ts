import { Column, Entity } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * Platform-wide DEFAULTS the super admin controls — a single row (id pinned to
 * {@link PLATFORM_SETTINGS_ID}). These apply to a NEW org at provisioning and as
 * the fallback for any org that has no explicit per-org override:
 *
 *   - `defaultOrgStorageGb`  → a new org's Team-Drive pool (`drive_quotas` team row).
 *   - `defaultUserQuotaGb`   → the default per-user My-Drive cap inside an org.
 *   - `defaultMaxMembers`    → seat cap (owner + members). `null` = unlimited.
 *
 * Storage is still physically enforced via `DriveQuotaEntity` (per org); this
 * table only holds the DEFAULTS used to seed / fall back to. Seat caps live per
 * org on `OrganizationEntity.limits.maxMembers`, defaulting to `defaultMaxMembers`.
 */
/** Fixed 24-char id for the single settings row (upsert target). */
export const PLATFORM_SETTINGS_ID = '000000000000000000000001';

@Entity('platform_settings')
export class PlatformSettingsEntity extends PgBaseEntity {
  /** Default Team-Drive allocation (GB) for a newly provisioned org. */
  @Column({ type: 'int', default: 50 })
  defaultOrgStorageGb: number;

  /** Default per-user My-Drive cap (GB) within an org. */
  @Column({ type: 'int', default: 1 })
  defaultUserQuotaGb: number;

  /** Default seat cap (owner + members); null = unlimited. */
  @Column({ type: 'int', nullable: true, default: null })
  defaultMaxMembers: number | null;

  /** Last super admin to change these (audit). */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  updatedBy: string | null;
}
