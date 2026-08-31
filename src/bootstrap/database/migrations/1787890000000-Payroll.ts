import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Payroll (Phase 1 — simple path) — `salary_structures` (per-employee monthly
 * salary) + `payslips` (immutable monthly artifact). Additive and reversible.
 */
export class Payroll1787890000000 implements MigrationInterface {
  name = 'Payroll1787890000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "salary_structures" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "user_id" character varying(24) NOT NULL,
        "employee_name" character varying,
        "employee_email" character varying,
        "monthly_salary" numeric(12,2) NOT NULL,
        "effective_from" TIMESTAMP WITH TIME ZONE NOT NULL,
        "supersedes" character varying(24),
        "created_by" character varying(24),
        "is_active" boolean NOT NULL DEFAULT true,
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_salary_structures_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_salary_org_user" ON "salary_structures" ("organization_id", "user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_salary_org_active" ON "salary_structures" ("organization_id", "is_active")`,
    );

    await queryRunner.query(`
      CREATE TABLE "payslips" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "user_id" character varying(24) NOT NULL,
        "month" integer NOT NULL,
        "year" integer NOT NULL,
        "monthly_salary" numeric(12,2) NOT NULL,
        "gross_earnings" numeric(12,2) NOT NULL,
        "lop_deduction" numeric(12,2) NOT NULL,
        "total_deductions" numeric(12,2) NOT NULL,
        "net_pay" numeric(12,2) NOT NULL,
        "net_pay_words" character varying(300) NOT NULL,
        "lop_details" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "employee_snapshot" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "org_snapshot" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "generated_by" character varying(24),
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_payslips_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "ux_payslip_user_period" ON "payslips" ("user_id", "year", "month")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_payslip_org_period" ON "payslips" ("organization_id", "year", "month")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "payslips"`);
    await queryRunner.query(`DROP TABLE "salary_structures"`);
  }
}
