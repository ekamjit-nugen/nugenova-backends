import { MigrationInterface, QueryRunner } from 'typeorm';

const BASE = `
  "id" character varying(24) NOT NULL,
  "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  "organization_id" character varying(24) NOT NULL,`;

/**
 * Recruitment v2 — candidates submitted against Sales lead requirements, with an
 * append-only status trail; client interviews linked to a submission; openings
 * raised from a requirement; and a headcount (`positions`) on requirements.
 */
export class RecruitmentLeadSubmissions1788440000000 implements MigrationInterface {
  name = 'RecruitmentLeadSubmissions1788440000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "recruitment_submissions" (${BASE}
        "lead_id" character varying(24) NOT NULL,
        "requirement_id" character varying(24),
        "candidate_id" character varying(24) NOT NULL,
        "application_id" character varying(24),
        "status" character varying NOT NULL DEFAULT 'shortlisted',
        "bill_rate" numeric(14,2),
        "bill_unit" character varying NOT NULL DEFAULT 'month',
        "cost_rate" numeric(14,2),
        "currency" character varying NOT NULL DEFAULT 'INR',
        "available_from" date,
        "proposed_start" date,
        "shared_document_id" character varying(24),
        "client_feedback" text,
        "rejection_reason" character varying,
        "owner_id" character varying(24),
        "account_manager_id" character varying(24),
        "submitted_at" TIMESTAMP WITH TIME ZONE,
        "decided_at" TIMESTAMP WITH TIME ZONE,
        "created_by" character varying(24),
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_recruitment_submissions" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE INDEX "ix_rec_submissions_lead" ON "recruitment_submissions" ("organization_id", "lead_id", "status")`);
    await q.query(`CREATE INDEX "ix_rec_submissions_requirement" ON "recruitment_submissions" ("organization_id", "requirement_id")`);
    await q.query(`CREATE INDEX "ix_rec_submissions_candidate" ON "recruitment_submissions" ("organization_id", "candidate_id")`);
    await q.query(`CREATE UNIQUE INDEX "ux_rec_submissions_target" ON "recruitment_submissions" ("organization_id", "lead_id", coalesce("requirement_id", ''), "candidate_id") WHERE "is_deleted" = false`);

    await q.query(`
      CREATE TABLE "recruitment_submission_events" (${BASE}
        "submission_id" character varying(24) NOT NULL,
        "from_status" character varying,
        "to_status" character varying NOT NULL,
        "note" text,
        "by_user_id" character varying(24),
        "at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_recruitment_submission_events" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE INDEX "ix_rec_submission_events_sub" ON "recruitment_submission_events" ("organization_id", "submission_id", "at")`);

    await q.query(`ALTER TABLE "recruitment_interviews" ADD COLUMN "submission_id" character varying(24)`);
    await q.query(`ALTER TABLE "recruitment_interviews" ADD COLUMN "kind" character varying NOT NULL DEFAULT 'internal'`);
    await q.query(`ALTER TABLE "recruitment_interviews" ALTER COLUMN "application_id" DROP NOT NULL`);
    await q.query(`ALTER TABLE "recruitment_interviews" ALTER COLUMN "opening_id" DROP NOT NULL`);
    await q.query(`ALTER TABLE "recruitment_interviews" ADD CONSTRAINT "ck_rec_interviews_target" CHECK ("application_id" IS NOT NULL OR "submission_id" IS NOT NULL)`);
    await q.query(`CREATE INDEX "ix_rec_interviews_submission" ON "recruitment_interviews" ("organization_id", "submission_id")`);

    await q.query(`ALTER TABLE "recruitment_openings" ADD COLUMN "lead_id" character varying(24)`);
    await q.query(`ALTER TABLE "recruitment_openings" ADD COLUMN "requirement_id" character varying(24)`);
    await q.query(`CREATE INDEX "ix_rec_openings_lead" ON "recruitment_openings" ("organization_id", "lead_id")`);

    await q.query(`ALTER TABLE "sales_requirements" ADD COLUMN IF NOT EXISTS "positions" integer`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "sales_requirements" DROP COLUMN IF EXISTS "positions"`);
    await q.query(`DROP INDEX IF EXISTS "ix_rec_openings_lead"`);
    await q.query(`ALTER TABLE "recruitment_openings" DROP COLUMN IF EXISTS "requirement_id"`);
    await q.query(`ALTER TABLE "recruitment_openings" DROP COLUMN IF EXISTS "lead_id"`);
    await q.query(`DROP INDEX IF EXISTS "ix_rec_interviews_submission"`);
    await q.query(`ALTER TABLE "recruitment_interviews" DROP CONSTRAINT IF EXISTS "ck_rec_interviews_target"`);
    await q.query(`DELETE FROM "recruitment_interviews" WHERE "application_id" IS NULL`);
    await q.query(`ALTER TABLE "recruitment_interviews" ALTER COLUMN "opening_id" SET NOT NULL`);
    await q.query(`ALTER TABLE "recruitment_interviews" ALTER COLUMN "application_id" SET NOT NULL`);
    await q.query(`ALTER TABLE "recruitment_interviews" DROP COLUMN IF EXISTS "kind"`);
    await q.query(`ALTER TABLE "recruitment_interviews" DROP COLUMN IF EXISTS "submission_id"`);
    await q.query(`DROP TABLE IF EXISTS "recruitment_submission_events"`);
    await q.query(`DROP TABLE IF EXISTS "recruitment_submissions"`);
  }
}
