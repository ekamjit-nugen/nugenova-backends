import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * LMS structure + enrolment — `courses`, `class_sections`, `enrolments`. The
 * education-vertical layer that sits on the academic calendar (years/terms).
 *
 * Invariants backed by indexes (so a race can't break them):
 *  - Course code UNIQUE per org among ACTIVE courses: partial-unique
 *    (org, code) WHERE is_active — archiving frees the code.
 *  - Class/section UNIQUE per (course, term, section).
 *  - Enrolment UNIQUE per (class, student) — no double-enrolment; withdraw is a
 *    soft status transition on that same row.
 */
export class Lms1788032000000 implements MigrationInterface {
  name = 'Lms1788032000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── courses ──────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "courses" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "academic_year_id" character varying(24),
        "code" character varying NOT NULL,
        "name" character varying NOT NULL,
        "description" text,
        "subject" character varying,
        "credits" integer,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_by" character varying(24),
        "updated_by" character varying(24),
        CONSTRAINT "PK_courses" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_course_org" ON "courses" ("organization_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_course_year" ON "courses" ("academic_year_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_course_org_code_active" ON "courses" ("organization_id", "code") WHERE "is_active" = true`,
    );

    // ── class_sections ───────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "class_sections" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "course_id" character varying(24) NOT NULL,
        "term_id" character varying(24) NOT NULL,
        "section" character varying NOT NULL,
        "teacher_membership_id" character varying(24),
        "capacity" integer,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_by" character varying(24),
        "updated_by" character varying(24),
        CONSTRAINT "PK_class_sections" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_class_org" ON "class_sections" ("organization_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_class_course" ON "class_sections" ("course_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_class_term" ON "class_sections" ("term_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_class_teacher" ON "class_sections" ("teacher_membership_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_class_course_term_section" ON "class_sections" ("course_id", "term_id", "section")`,
    );

    // ── enrolments ───────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "enrolments" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "class_id" character varying(24) NOT NULL,
        "student_membership_id" character varying(24) NOT NULL,
        "status" character varying(16) NOT NULL DEFAULT 'enrolled',
        "enrolled_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "withdrawn_at" TIMESTAMP WITH TIME ZONE,
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "created_by" character varying(24),
        "updated_by" character varying(24),
        CONSTRAINT "PK_enrolments" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_enrolment_org" ON "enrolments" ("organization_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_enrolment_class" ON "enrolments" ("class_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_enrolment_student" ON "enrolments" ("student_membership_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_enrolment_class_student" ON "enrolments" ("class_id", "student_membership_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "uq_enrolment_class_student"`);
    await queryRunner.query(`DROP INDEX "ix_enrolment_student"`);
    await queryRunner.query(`DROP INDEX "ix_enrolment_class"`);
    await queryRunner.query(`DROP INDEX "ix_enrolment_org"`);
    await queryRunner.query(`DROP TABLE "enrolments"`);

    await queryRunner.query(`DROP INDEX "uq_class_course_term_section"`);
    await queryRunner.query(`DROP INDEX "ix_class_teacher"`);
    await queryRunner.query(`DROP INDEX "ix_class_term"`);
    await queryRunner.query(`DROP INDEX "ix_class_course"`);
    await queryRunner.query(`DROP INDEX "ix_class_org"`);
    await queryRunner.query(`DROP TABLE "class_sections"`);

    await queryRunner.query(`DROP INDEX "uq_course_org_code_active"`);
    await queryRunner.query(`DROP INDEX "ix_course_year"`);
    await queryRunner.query(`DROP INDEX "ix_course_org"`);
    await queryRunner.query(`DROP TABLE "courses"`);
  }
}
