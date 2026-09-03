import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * One document slot on a member's onboarding, seeded from the org's onboarding
 * policy config and reconciled-on-read as the policy changes. `fileId` points at
 * the uploaded bytes in the media/storage store once the hire submits.
 */
export interface OnboardingDocumentSlot {
  key: string;
  title: string;
  required: boolean;
  /** pending → uploaded → verified | rejected (rejected re-opens for re-upload). */
  status: 'pending' | 'uploaded' | 'verified' | 'rejected';
  fileId?: string | null;
  uploadedAt?: string | null;
  verifiedAt?: string | null;
  verifiedBy?: string | null;
  note?: string | null;
  /**
   * An ad-hoc document HR requested from this employee (from Directory or the
   * Onboarding page), rather than one seeded from the onboarding policy. Ad-hoc
   * slots are preserved across policy reconciliation even while still pending.
   */
  adhoc?: boolean;
  /** Optional instructions shown to the employee for an ad-hoc request. */
  description?: string | null;
  requestedBy?: string | null;
  requestedAt?: string | null;
}

/** One checklist task on a member's onboarding. `assignedTo` gates completion. */
export interface OnboardingChecklistSlot {
  key: string;
  title: string;
  category: string;
  assignedTo: 'self' | 'hr' | 'it';
  status: 'pending' | 'done';
  completedAt?: string | null;
  completedBy?: string | null;
}

/**
 * MemberOnboarding — the employee onboarding lifecycle record. In Nexora the
 * person IS the `OrgMembership` (there is no separate HR Employee entity), so
 * this attaches to a membership by `membershipId` (+ `userId` for the self-
 * service lookup). Seeded from the org's onboarding policy config on initiate.
 *
 * State: pending → in_progress → completed | cancelled. `in_progress` is entered
 * on the first upload/checklist action; `completed` is HR-confirmed. A cancelled
 * record is superseded (soft) when the same member is re-onboarded.
 */
@Entity('member_onboardings')
@Index('ix_member_onboarding_org', ['organizationId'])
@Index('ix_member_onboarding_org_status', ['organizationId', 'status'])
@Index('ix_member_onboarding_membership', ['membershipId'])
@Index('ix_member_onboarding_user', ['userId'])
export class MemberOnboardingEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  membershipId: string;

  /** The onboarded user (null only if the membership has no linked user yet). */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  userId: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  employeeEmail: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  employeeName: string | null;

  /** pending | in_progress | completed | cancelled */
  @Column({ type: 'varchar', default: 'pending' })
  status: string;

  // Snapshot of role/department at initiate (denormalized for the HR list).
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  roleId: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  role: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  departmentId: string | null;

  /** Optional buddy / reporting manager (a userId). */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  reportingManagerId: string | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  startDate: Date | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  targetDate: Date | null;

  @Column({ type: 'int', nullable: true, default: null })
  probationMonths: number | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  probationEndDate: Date | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  documents: OnboardingDocumentSlot[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  checklist: OnboardingChecklistSlot[];

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  initiatedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  completedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  lastReminderAt: Date | null;

  @Column({ type: 'boolean', default: false })
  isDeleted: boolean;
}
