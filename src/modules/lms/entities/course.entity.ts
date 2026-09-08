import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * Course — a catalog subject an org teaches (e.g. "MATH-101 Algebra I"). Sits on
 * top of the academic calendar: a course may be pinned to an `academicYearId`
 * (the year its syllabus belongs to) or left year-agnostic. The taught instances
 * of a course live in `class_sections` (a course in a specific term with a
 * teacher + roster); a Course itself carries no students.
 *
 * `code` is the org's short identifier for the course and is UNIQUE per org while
 * the course is active (partial-unique `WHERE is_active = true`) — an archived
 * course (`isActive = false`) frees its code for reuse. Owner/admin authored,
 * always tenant-scoped.
 */
@Entity('courses')
@Index('ix_course_org', ['organizationId'])
@Index('ix_course_year', ['academicYearId'])
// One ACTIVE course per (org, code). Archiving (isActive=false) frees the code.
@Index('uq_course_org_code_active', ['organizationId', 'code'], {
  unique: true,
  where: `"is_active" = true`,
})
export class CourseEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  /** Optional anchor to an academic year; null = year-agnostic catalog entry. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  academicYearId: string | null;

  @Column({ type: 'varchar' })
  code: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'text', nullable: true, default: null })
  description: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  subject: string | null;

  @Column({ type: 'int', nullable: true, default: null })
  credits: number | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  updatedBy: string | null;
}
