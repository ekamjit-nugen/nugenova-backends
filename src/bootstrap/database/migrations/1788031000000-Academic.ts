import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Academic calendar — `academic_years` + `terms`. The education-vertical
 * foundation the future gradebook anchors to (laid down before any student row
 * exists so it never has to be retrofitted).
 *
 * Invariants backed by indexes:
 *  - ONE current academic year per org: partial-unique on (org) WHERE is_current.
 *  - Unique year name per org.
 *  - Ordered, unique terms within a year: unique (academic_year_id, sequence).
 */
export class Academic1788031000000 implements MigrationInterface {
  name = 'Academic1788031000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "academic_years" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "name" character varying NOT NULL,
        "start_date" date NOT NULL,
        "end_date" date NOT NULL,
        "is_current" boolean NOT NULL DEFAULT false,
        "created_by" character varying(24),
        "updated_by" character varying(24),
        CONSTRAINT "PK_academic_years" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_academic_year_org" ON "academic_years" ("organization_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_academic_year_current" ON "academic_years" ("organization_id") WHERE "is_current" = true`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_academic_year_org_name" ON "academic_years" ("organization_id", "name")`,
    );

    await queryRunner.query(`
      CREATE TABLE "terms" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "academic_year_id" character varying(24) NOT NULL,
        "organization_id" character varying(24) NOT NULL,
        "name" character varying NOT NULL,
        "start_date" date NOT NULL,
        "end_date" date NOT NULL,
        "sequence" integer NOT NULL,
        "created_by" character varying(24),
        "updated_by" character varying(24),
        CONSTRAINT "PK_terms" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_term_org" ON "terms" ("organization_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_term_year" ON "terms" ("academic_year_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_term_year_sequence" ON "terms" ("academic_year_id", "sequence")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "uq_term_year_sequence"`);
    await queryRunner.query(`DROP INDEX "ix_term_year"`);
    await queryRunner.query(`DROP INDEX "ix_term_org"`);
    await queryRunner.query(`DROP TABLE "terms"`);
    await queryRunner.query(`DROP INDEX "uq_academic_year_org_name"`);
    await queryRunner.query(`DROP INDEX "uq_academic_year_current"`);
    await queryRunner.query(`DROP INDEX "ix_academic_year_org"`);
    await queryRunner.query(`DROP TABLE "academic_years"`);
  }
}
