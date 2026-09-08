import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * Mark — one student's score on one assessment (the gradebook CELL). Links an
 * assessment to the student's `enrolments` row in that class; `studentMembershipId`
 * is DENORMALIZED off the enrolment so the row can be scoped/rendered without a
 * join and so the STUDENT identity is pinned at grade time.
 *
 * UNIQUE (assessmentId, enrolmentId) — a student has at most ONE mark per
 * assessment. A re-grade FLIPS THE SAME ROW (mirrors the lms enrolment
 * "re-enrol on the same row" pattern) rather than inserting a duplicate, so the
 * unique index is never violated and history isn't forked.
 *
 * `marksObtained` is nullable: a null cell means "not yet graded" (distinct from a
 * genuine zero). Only graded cells count toward a student's weighted total.
 */
@Entity('assessment_marks')
@Index('ix_mark_org', ['organizationId'])
@Index('ix_mark_assessment', ['assessmentId'])
@Index('ix_mark_enrolment', ['enrolmentId'])
@Index('ix_mark_student', ['studentMembershipId'])
// One mark row per (assessment, enrolment) — a re-grade updates this same row.
@Index('uq_mark_assessment_enrolment', ['assessmentId', 'enrolmentId'], {
  unique: true,
})
export class MarkEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  assessmentId: string;

  /** The student's enrolment in the assessment's class (`enrolments.id`). */
  @Column({ type: 'varchar', length: 24 })
  enrolmentId: string;

  /** Denormalized STUDENT membership id (from the enrolment) — scoping + identity. */
  @Column({ type: 'varchar', length: 24 })
  studentMembershipId: string;

  /** null = not yet graded (NOT a zero). numeric → read back via Number(). */
  @Column({ type: 'numeric', precision: 10, scale: 2, nullable: true, default: null })
  marksObtained: number | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  gradedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  gradedAt: Date | null;

  @Column({ type: 'text', nullable: true, default: null })
  remark: string | null;
}
