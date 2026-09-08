import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * GuardianLink — maps a GUARDIAN membership to a STUDENT membership (§04's
 * client-portal pattern, re-cast for education). One guardian may be linked to
 * many students (siblings) and one student may have several guardians; this join
 * carries the `relationship` and which link is `isPrimary` (the primary contact).
 *
 * Both sides are `org_memberships` rows constrained by personType: the guardian
 * side MUST be `personType='guardian'`, the student side `personType='student'`
 * (validated in the service — the same personType guard the LMS relies on). The
 * link is the edge the consent ledger authorizes against: a guardian may only
 * grant/revoke consent for a student they are linked to.
 *
 * UNIQUE (guardian, student). Unlinking is SOFT (`deactivatedAt` stamped), never
 * a delete, so consent history keeps resolving; a later re-link flips the SAME
 * row back (never violating the unique index).
 */
@Entity('guardian_links')
@Index('ix_guardian_link_org', ['organizationId'])
@Index('ix_guardian_link_guardian', ['guardianMembershipId'])
@Index('ix_guardian_link_student', ['studentMembershipId'])
@Index(
  'uq_guardian_link_pair',
  ['guardianMembershipId', 'studentMembershipId'],
  { unique: true },
)
export class GuardianLinkEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  guardianMembershipId: string;

  @Column({ type: 'varchar', length: 24 })
  studentMembershipId: string;

  /** e.g. mother | father | guardian | grandparent — free text, defaulted. */
  @Column({ type: 'varchar', length: 32, default: 'guardian' })
  relationship: string;

  /** The primary contact for this student (at most one, enforced in service). */
  @Column({ type: 'boolean', default: false })
  isPrimary: boolean;

  /** Soft-unlink marker; null = active. Keeps consent history resolvable. */
  @Column({ type: 'timestamptz', nullable: true, default: null })
  deactivatedAt: Date | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  updatedBy: string | null;
}
