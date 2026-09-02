import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Timesheets — employees submit weekly/monthly timesheets (cadence per the
 * timesheet policy) for a manager's approval. Additive/reversible.
 */
export class Timesheets1787970000000 implements MigrationInterface {
  name = 'Timesheets1787970000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "timesheets" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "user_id" character varying(24) NOT NULL,
        "employee_name" character varying,
        "employee_email" character varying,
        "cadence" character varying NOT NULL DEFAULT 'monthly',
        "period_start" TIMESTAMP WITH TIME ZONE NOT NULL,
        "period_end" TIMESTAMP WITH TIME ZONE NOT NULL,
        "entries" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "total_hours" numeric(8,2) NOT NULL DEFAULT 0,
        "status" character varying NOT NULL DEFAULT 'draft',
        "submitted_at" TIMESTAMP WITH TIME ZONE,
        "reviewed_by" character varying(24),
        "reviewed_at" TIMESTAMP WITH TIME ZONE,
        "review_note" text,
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_timesheets_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ux_timesheet_period" ON "timesheets" ("organization_id", "user_id", "period_start", "is_deleted")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_timesheet_org_status" ON "timesheets" ("organization_id", "status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "timesheets"`);
  }
}
