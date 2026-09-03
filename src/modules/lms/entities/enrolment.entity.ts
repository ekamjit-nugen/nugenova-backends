import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/** An enrolment's lifecycle status. Withdraw/complete are soft transitions. */
export type EnrolmentStatus = 'enrolled' | 'withdrawn' | 'completed';
export const ENROLMENT_STATUSES: readonly EnrolmentStatus[] = [
  'enrolled',
  'withdrawn',
  'completed',
];

/**
 * Enrolment — links a STUDENT membership to a ClassSection. This is the ONLY
 * place a student membership meets the academic structure, and it is where the
 * personType guard bites the other way round: `studentMembershipId` MUST be a
 * membership with `personType='student'` (staff/guardian are rejected 400 in the
 * service). Students never appear on staff surfaces; staff never appear here.
 *
 * UNIQUE (classId, studentMembershipId) — a student can hold at most ONE row per
 * class, so there is no double-enrolment. Withdrawing is a status transition on
 * that same row (soft, `withdrawnAt` stamped), NOT a delete — so history and any
 * future grades survive, and a later re-enrol flips the same row back to
 * 'enrolled' rather than violating the unique index.
 */
@Entity('enrolments')
@Index('ix_enrolment_org', ['organizationId'])
@Index('ix_enrolment_class', ['classId'])
@Index('ix_enrolment_student', ['studentMembershipId'])
// One enrolment row per (class, student) — no double-enrolment.
@Index('uq_enrolment_class_student', ['classId', 'studentMembershipId'], {
  unique: true,
})
export class EnrolmentEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  classId: string;

  @Column({ type: 'varchar', length: 24 })
  studentMembershipId: string;

  @Column({ type: 'varchar', length: 16, default: 'enrolled' })
  status: EnrolmentStatus;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  enrolledAt: Date;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  withdrawnAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  completedAt: Date | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  updatedBy: string | null;
}
