import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * ClassSection — a taught instance of a Course in a specific Term (what a
 * gradebook, timetable and enrolment actually hang off). One course can run as
 * several sections in the same term ("A", "B", …); `section` is the label that
 * distinguishes them, UNIQUE per (course, term).
 *
 * `teacherMembershipId` (optional) MUST reference a STAFF membership — a student
 * can never teach. That is validated at assignment time in the service with
 * `staffScope()` (personType='staff'), NOT enforceable by a column constraint,
 * so the check lives in LmsService.assertTeacherIsStaff.
 *
 * `capacity` (optional) caps the number of actively-enrolled students; the
 * enrolment path enforces it under a row lock so a race can't overfill a class.
 */
@Entity('class_sections')
@Index('ix_class_org', ['organizationId'])
@Index('ix_class_course', ['courseId'])
@Index('ix_class_term', ['termId'])
@Index('ix_class_teacher', ['teacherMembershipId'])
// One section label per (course, term).
@Index('uq_class_course_term_section', ['courseId', 'termId', 'section'], {
  unique: true,
})
export class ClassSectionEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  courseId: string;

  @Column({ type: 'varchar', length: 24 })
  termId: string;

  /** The section label ("A", "Morning", …) — distinguishes sections of a course/term. */
  @Column({ type: 'varchar' })
  section: string;

  /** Optional assigned teacher — MUST be a staff membership (validated in service). */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  teacherMembershipId: string | null;

  /** Optional seat cap on ACTIVE (status='enrolled') students. */
  @Column({ type: 'int', nullable: true, default: null })
  capacity: number | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  updatedBy: string | null;
}
