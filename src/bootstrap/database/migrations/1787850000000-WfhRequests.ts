import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * WFH request/approval — the `wfh_requests` table. WFH becomes an approval flow
 * (request → owner/HR approves → clock-in on a covered day counts as WFH).
 * Additive and reversible; the Mongo monolith is untouched.
 */
export class WfhRequests1787850000000 implements MigrationInterface {
  name = 'WfhRequests1787850000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "wfh_requests" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "user_id" character varying(24) NOT NULL,
        "employee_name" character varying,
        "employee_email" character varying,
        "start_date" TIMESTAMP WITH TIME ZONE NOT NULL,
        "end_date" TIMESTAMP WITH TIME ZONE NOT NULL,
        "reason" text,
        "status" character varying NOT NULL DEFAULT 'pending',
        "reviewed_by" character varying(24),
        "review_note" text,
        "reviewed_at" TIMESTAMP WITH TIME ZONE,
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_wfh_requests_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_wfh_org_status" ON "wfh_requests" ("organization_id", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_wfh_org_user" ON "wfh_requests" ("organization_id", "user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_wfh_user_dates" ON "wfh_requests" ("user_id", "start_date", "end_date")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "wfh_requests"`);
  }
}
