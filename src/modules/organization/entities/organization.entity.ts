import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * Organization — a tenant. Provisioned by a platform (super) admin, who names it
 * and nominates an owner; the owner then sets up departments, roles and team.
 *
 * `ownerId` is the user who administers the tenant; `createdBy` is the platform
 * admin who provisioned it. `slug` is a URL-safe unique handle derived from the
 * name at creation. Kept deliberately thin for Phase 2 — richer settings/billing
 * land with later modules.
 */
@Entity('organizations')
export class OrganizationEntity extends PgBaseEntity {
  @Column({ type: 'varchar' })
  name: string;

  @Index({ unique: true })
  @Column({ type: 'varchar' })
  slug: string;

  @Column({ type: 'varchar', default: 'active' })
  status: string; // active | suspended  (suspended = manually halted)

  /**
   * The Terms & Conditions document (from the T&C library) this org must accept.
   * Chosen by the super admin at creation. Required in practice; nullable only
   * for defensive back-compat. See `PlatformTermsEntity`.
   */
  @Index()
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  termsId: string | null;

  /**
   * The org's acceptance of its assigned T&C (`termsId`). Null until the owner
   * accepts. `termsId` pins WHICH document was accepted and `version` WHICH edit
   * of it — if the super admin edits that T&C (bumping its version) or the org is
   * reassigned a different T&C, this becomes stale and the org must re-accept
   * (enforced in auth routing + the org guard).
   */
  @Column({ type: 'jsonb', nullable: true, default: null })
  consent: {
    termsId: string;
    version: number;
    acceptedByUserId: string;
    acceptedAt: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  } | null;

  @Index()
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  ownerId: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  /**
   * Free-form workspace configuration collected by the owner's setup wizard:
   * `{ industry, size, website, timezone, currency, workModel, workHours:{start,end},
   * workDays[], leavePolicy, meetingCulture, methodology, logo }`.
   */
  @Column({ type: 'jsonb', nullable: true, default: null })
  settings: Record<string, unknown> | null;

  /** Owner setup-wizard progress (0 = not started; 1..5 = current step). */
  @Column({ type: 'int', default: 0 })
  onboardingStep: number;

  /** Whether the owner finished (or skipped) the setup wizard. */
  @Column({ type: 'boolean', default: false })
  onboardingCompleted: boolean;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  deletedAt: Date | null;
}
