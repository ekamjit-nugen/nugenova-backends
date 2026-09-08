import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/** The kind of assessment. Free enough for a school gradebook, closed for validation. */
export type AssessmentType = 'quiz' | 'assignment' | 'exam' | 'project';
export const ASSESSMENT_TYPES: readonly AssessmentType[] = [
  'quiz',
  'assignment',
  'exam',
  'project',
];

/**
 * Assessment — a graded item (quiz/assignment/exam/project) attached to a taught
 * `class_sections` row and, through it, to the calendar `term` the class runs in.
 * This is the gradebook COLUMN; the per-student cells live in `assessment_marks`.
 *
 * `classSectionId` references `class_sections.id` (the same row lms enrolments
 * point at via their `classId`). `termId` is DERIVED from the class at creation
 * time — a class is already anchored to exactly one term, so the assessment can
 * never disagree with its class's calendar (see AssessmentService.createAssessment).
 *
 * `maxMarks` is the denominator every cell is scored out of; `weight` is the
 * assessment's contribution to the class's weighted total (see the gradebook
 * computation). `published` is an author-facing visibility flag reserved for a
 * future student/guardian-facing surface — the admin/teacher gradebook shows all
 * assessments regardless. Owner/admin authored, always tenant-scoped.
 */
@Entity('assessments')
@Index('ix_assessment_org', ['organizationId'])
// Primary read path: every assessment of a class, tenant-scoped.
@Index('ix_assessment_org_class', ['organizationId', 'classSectionId'])
@Index('ix_assessment_term', ['termId'])
export class AssessmentEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  /** The taught class/section this assessment belongs to (`class_sections.id`). */
  @Column({ type: 'varchar', length: 24 })
  classSectionId: string;

  /** The term the class runs in — derived from the class, never taken from the client. */
  @Column({ type: 'varchar', length: 24 })
  termId: string;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'varchar', length: 16 })
  type: AssessmentType;

  /** The denominator every mark is scored out of. numeric → read back via Number(). */
  @Column({ type: 'numeric', precision: 10, scale: 2 })
  maxMarks: number;

  /** Relative weight toward the class's weighted total. Defaults to 1. */
  @Column({ type: 'numeric', precision: 10, scale: 2, default: 1 })
  weight: number;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  dueDate: Date | null;

  /** Author-facing visibility flag; reserved for a future student-facing surface. */
  @Column({ type: 'boolean', default: false })
  published: boolean;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  updatedBy: string | null;
}
