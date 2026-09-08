import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Assessment / gradebook — `assessments` (graded items on a class/section) and
 * `assessment_marks` (per-student cells). The education-vertical layer that sits
 * on the lms roster (`class_sections` + `enrolments`) and, through the class, on
 * the academic calendar.
 *
 * Invariants backed by indexes (so a race can't break them):
 *  - A mark is UNIQUE per (assessment, enrolment) — no duplicate cell; a re-grade
 *    updates that same row.
 */
export class Assessment1788100000000 implements MigrationInterface {
  name = 'Assessment1788100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── assessments ────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "assessments" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "class_section_id" character varying(24) NOT NULL,
        "term_id" character varying(24) NOT NULL,
        "title" character varying NOT NULL,
        "type" character varying(16) NOT NULL,
        "max_marks" numeric(10,2) NOT NULL,
        "weight" numeric(10,2) NOT NULL DEFAULT 1,
        "due_date" TIMESTAMP WITH TIME ZONE,
        "published" boolean NOT NULL DEFAULT false,
        "created_by" character varying(24),
        "updated_by" character varying(24),
        CONSTRAINT "PK_assessments" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_assessment_org" ON "assessments" ("organization_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_assessment_org_class" ON "assessments" ("organization_id", "class_section_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_assessment_term" ON "assessments" ("term_id")`,
    );

    // ── assessment_marks ───────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "assessment_marks" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "assessment_id" character varying(24) NOT NULL,
        "enrolment_id" character varying(24) NOT NULL,
        "student_membership_id" character varying(24) NOT NULL,
        "marks_obtained" numeric(10,2),
        "graded_by" character varying(24),
        "graded_at" TIMESTAMP WITH TIME ZONE,
        "remark" text,
        CONSTRAINT "PK_assessment_marks" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_mark_org" ON "assessment_marks" ("organization_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_mark_assessment" ON "assessment_marks" ("assessment_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_mark_enrolment" ON "assessment_marks" ("enrolment_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_mark_student" ON "assessment_marks" ("student_membership_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_mark_assessment_enrolment" ON "assessment_marks" ("assessment_id", "enrolment_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "uq_mark_assessment_enrolment"`);
    await queryRunner.query(`DROP INDEX "ix_mark_student"`);
    await queryRunner.query(`DROP INDEX "ix_mark_enrolment"`);
    await queryRunner.query(`DROP INDEX "ix_mark_assessment"`);
    await queryRunner.query(`DROP INDEX "ix_mark_org"`);
    await queryRunner.query(`DROP TABLE "assessment_marks"`);

    await queryRunner.query(`DROP INDEX "ix_assessment_term"`);
    await queryRunner.query(`DROP INDEX "ix_assessment_org_class"`);
    await queryRunner.query(`DROP INDEX "ix_assessment_org"`);
    await queryRunner.query(`DROP TABLE "assessments"`);
  }
}
