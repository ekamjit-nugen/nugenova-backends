import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Employee onboarding lifecycle — the `member_onboardings` table. One record per
 * onboarded membership, seeded from the org's onboarding policy config. Additive
 * and reversible; the Mongo monolith is untouched.
 */
export class MemberOnboarding1787840000000 implements MigrationInterface {
  name = 'MemberOnboarding1787840000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "member_onboardings" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "membership_id" character varying(24) NOT NULL,
        "user_id" character varying(24),
        "employee_email" character varying,
        "employee_name" character varying,
        "status" character varying NOT NULL DEFAULT 'pending',
        "role_id" character varying(24),
        "role" character varying,
        "department_id" character varying(24),
        "reporting_manager_id" character varying(24),
        "start_date" TIMESTAMP WITH TIME ZONE,
        "target_date" TIMESTAMP WITH TIME ZONE,
        "probation_months" integer,
        "probation_end_date" TIMESTAMP WITH TIME ZONE,
        "documents" jsonb NOT NULL DEFAULT '[]',
        "checklist" jsonb NOT NULL DEFAULT '[]',
        "initiated_by" character varying(24),
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "last_reminder_at" TIMESTAMP WITH TIME ZONE,
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_member_onboardings_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_member_onboarding_org" ON "member_onboardings" ("organization_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_member_onboarding_org_status" ON "member_onboardings" ("organization_id", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_member_onboarding_membership" ON "member_onboardings" ("membership_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_member_onboarding_user" ON "member_onboardings" ("user_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "member_onboardings"`);
  }
}
