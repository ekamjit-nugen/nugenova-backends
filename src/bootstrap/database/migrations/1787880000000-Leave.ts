import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Leave management — `leave_requests` (applications) + `leave_balances` (per
 * user/year per-type balance). Additive and reversible; the Mongo monolith is
 * untouched.
 */
export class Leave1787880000000 implements MigrationInterface {
  name = 'Leave1787880000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "leave_requests" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "user_id" character varying(24) NOT NULL,
        "employee_name" character varying,
        "employee_email" character varying,
        "leave_type" character varying NOT NULL,
        "start_date" TIMESTAMP WITH TIME ZONE NOT NULL,
        "end_date" TIMESTAMP WITH TIME ZONE NOT NULL,
        "total_days" numeric(5,1) NOT NULL,
        "half_day" boolean NOT NULL DEFAULT false,
        "half_day_slot" character varying,
        "reason" text NOT NULL,
        "status" character varying NOT NULL DEFAULT 'pending',
        "reviewed_by" character varying(24),
        "reviewed_at" TIMESTAMP WITH TIME ZONE,
        "review_note" text,
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_leave_requests_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_leave_org_status" ON "leave_requests" ("organization_id", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_leave_org_user" ON "leave_requests" ("organization_id", "user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_leave_user_dates" ON "leave_requests" ("user_id", "start_date", "end_date")`,
    );

    await queryRunner.query(`
      CREATE TABLE "leave_balances" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "user_id" character varying(24) NOT NULL,
        "year" integer NOT NULL,
        "balances" jsonb NOT NULL DEFAULT '[]'::jsonb,
        CONSTRAINT "PK_leave_balances_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "ux_leave_balance_user_year" ON "leave_balances" ("user_id", "year")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_leave_balance_org_year" ON "leave_balances" ("organization_id", "year")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "leave_balances"`);
    await queryRunner.query(`DROP TABLE "leave_requests"`);
  }
}
