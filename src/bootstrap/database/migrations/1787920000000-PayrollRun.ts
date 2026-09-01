import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Payroll Phase B — the governed run. `payroll_runs` (lifecycle + maker-checker),
 * and `payslips` gains a link to its run + a `status` (draft until the run is
 * finalized, then final). Additive/reversible; existing payslips default to
 * `final` so nothing changes for the direct-generate path.
 */
export class PayrollRun1787920000000 implements MigrationInterface {
  name = 'PayrollRun1787920000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "payroll_runs" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "month" integer NOT NULL,
        "year" integer NOT NULL,
        "run_number" character varying(20) NOT NULL,
        "status" character varying NOT NULL DEFAULT 'draft',
        "totals" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "prepared_by" character varying(24),
        "prepared_at" TIMESTAMP WITH TIME ZONE,
        "approved_by" character varying(24),
        "approved_at" TIMESTAMP WITH TIME ZONE,
        "finalized_by" character varying(24),
        "finalized_at" TIMESTAMP WITH TIME ZONE,
        "note" text,
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_payroll_runs_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ux_payroll_run_period" ON "payroll_runs" ("organization_id", "year", "month", "is_deleted")`,
    );

    await queryRunner.query(
      `ALTER TABLE "payslips" ADD COLUMN "payroll_run_id" character varying(24)`,
    );
    await queryRunner.query(
      `ALTER TABLE "payslips" ADD COLUMN "status" character varying NOT NULL DEFAULT 'final'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payslips" DROP COLUMN "status"`);
    await queryRunner.query(`ALTER TABLE "payslips" DROP COLUMN "payroll_run_id"`);
    await queryRunner.query(`DROP TABLE "payroll_runs"`);
  }
}
