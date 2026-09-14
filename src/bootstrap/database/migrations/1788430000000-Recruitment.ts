import { MigrationInterface, QueryRunner } from 'typeorm';

const BASE = `
  "id" character varying(24) NOT NULL,
  "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  "organization_id" character varying(24) NOT NULL,`;

const RECRUITMENT_PERMISSION = `[{"resource":"recruitment","actions":["view","create","edit","delete","export","assign"]}]`;

/**
 * Recruitment (ATS): openings, pipeline stages, candidates (+ CV documents and a
 * full-text `search_tsv`), applications with a stage-event trail, interviews with
 * scorecard feedback, offers, the candidate timeline and per-org settings.
 * Also grants the new `recruitment` resource to existing owner/admin/hr roles.
 */
export class Recruitment1788430000000 implements MigrationInterface {
  name = 'Recruitment1788430000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "recruitment_openings" (${BASE}
        "title" character varying NOT NULL,
        "code" character varying,
        "department_id" character varying(24),
        "location" character varying,
        "work_mode" character varying NOT NULL DEFAULT 'onsite',
        "employment_type" character varying NOT NULL DEFAULT 'full_time',
        "exp_min_years" integer,
        "exp_max_years" integer,
        "budget_min" numeric(14,2),
        "budget_max" numeric(14,2),
        "currency" character varying NOT NULL DEFAULT 'INR',
        "positions" integer NOT NULL DEFAULT 1,
        "skills" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "description" text,
        "hiring_manager_id" character varying(24),
        "recruiter_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "status" character varying NOT NULL DEFAULT 'open',
        "priority" character varying NOT NULL DEFAULT 'medium',
        "target_date" date,
        "scorecard_template_id" character varying(24),
        "opened_at" TIMESTAMP WITH TIME ZONE,
        "closed_at" TIMESTAMP WITH TIME ZONE,
        "created_by" character varying(24),
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_recruitment_openings" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE INDEX "ix_rec_openings_org_status" ON "recruitment_openings" ("organization_id", "status")`);
    await q.query(`CREATE UNIQUE INDEX "ux_rec_openings_org_code" ON "recruitment_openings" ("organization_id", lower("code")) WHERE "is_deleted" = false AND "code" IS NOT NULL`);

    await q.query(`
      CREATE TABLE "recruitment_stages" (${BASE}
        "name" character varying NOT NULL,
        "order" integer NOT NULL,
        "kind" character varying NOT NULL DEFAULT 'active',
        "color" character varying,
        "is_default" boolean NOT NULL DEFAULT false,
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_recruitment_stages" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE INDEX "ix_rec_stages_org" ON "recruitment_stages" ("organization_id")`);

    await q.query(`
      CREATE TABLE "candidates" (${BASE}
        "full_name" character varying NOT NULL,
        "email" character varying,
        "email_norm" character varying,
        "phone" character varying,
        "phone_norm" character varying,
        "alt_phone" character varying,
        "current_location" character varying,
        "preferred_locations" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "willing_to_relocate" boolean,
        "total_exp_months" integer,
        "relevant_exp_months" integer,
        "current_company" character varying,
        "current_designation" character varying,
        "current_ctc" numeric(14,2),
        "expected_ctc" numeric(14,2),
        "currency" character varying NOT NULL DEFAULT 'INR',
        "notice_period_days" integer,
        "notice_status" character varying NOT NULL DEFAULT 'unknown',
        "last_working_day" date,
        "highest_qualification" character varying,
        "education" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "work_history" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "skills" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "linkedin_url" character varying,
        "github_url" character varying,
        "portfolio_url" character varying,
        "source" character varying NOT NULL DEFAULT 'other',
        "source_detail" character varying,
        "referred_by" character varying(24),
        "external_resume_url" character varying,
        "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "rating" integer,
        "ai_summary" text,
        "resume_text" text,
        "owner_id" character varying(24),
        "status" character varying NOT NULL DEFAULT 'active',
        "consent_at" TIMESTAMP WITH TIME ZONE,
        "last_activity_at" TIMESTAMP WITH TIME ZONE,
        "created_by" character varying(24),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "search_tsv" tsvector GENERATED ALWAYS AS (
          setweight(to_tsvector('simple', coalesce("full_name", '')), 'A') ||
          setweight(to_tsvector('simple',
            coalesce("email", '') || ' ' || coalesce("phone_norm", '') || ' ' ||
            coalesce("current_company", '') || ' ' || coalesce("current_designation", '') || ' ' ||
            coalesce("skills"::text, '') || ' ' || coalesce("tags"::text, '')), 'B') ||
          setweight(to_tsvector('simple',
            coalesce("current_location", '') || ' ' || coalesce("highest_qualification", '') || ' ' ||
            coalesce("ai_summary", '')), 'C') ||
          setweight(to_tsvector('simple', left(coalesce("resume_text", ''), 200000)), 'D')
        ) STORED,
        CONSTRAINT "pk_candidates" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE INDEX "ix_candidates_org_status" ON "candidates" ("organization_id", "status")`);
    await q.query(`CREATE INDEX "ix_candidates_org_owner" ON "candidates" ("organization_id", "owner_id")`);
    await q.query(`CREATE INDEX "ix_candidates_org_updated" ON "candidates" ("organization_id", "updated_at" DESC)`);
    await q.query(`CREATE INDEX "ix_candidates_search" ON "candidates" USING GIN ("search_tsv")`);
    await q.query(`CREATE INDEX "ix_candidates_skills" ON "candidates" USING GIN ("skills")`);
    await q.query(`CREATE UNIQUE INDEX "ux_candidates_org_email" ON "candidates" ("organization_id", "email_norm") WHERE "is_deleted" = false AND "email_norm" IS NOT NULL`);
    await q.query(`CREATE UNIQUE INDEX "ux_candidates_org_phone" ON "candidates" ("organization_id", "phone_norm") WHERE "is_deleted" = false AND "phone_norm" IS NOT NULL`);

    await q.query(`
      CREATE TABLE "candidate_documents" (${BASE}
        "candidate_id" character varying(24) NOT NULL,
        "file_id" character varying(24) NOT NULL,
        "kind" character varying NOT NULL DEFAULT 'resume',
        "file_name" character varying NOT NULL,
        "mime_type" character varying,
        "size" bigint,
        "is_primary" boolean NOT NULL DEFAULT false,
        "version" integer NOT NULL DEFAULT 1,
        "extracted_text" text,
        "parse_status" character varying NOT NULL DEFAULT 'pending',
        "parsed_json" jsonb,
        "created_by" character varying(24),
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_candidate_documents" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE INDEX "ix_candidate_docs_candidate" ON "candidate_documents" ("organization_id", "candidate_id")`);
    await q.query(`CREATE INDEX "ix_candidate_docs_file" ON "candidate_documents" ("file_id")`);

    await q.query(`
      CREATE TABLE "candidate_applications" (${BASE}
        "candidate_id" character varying(24) NOT NULL,
        "opening_id" character varying(24) NOT NULL,
        "stage_id" character varying(24) NOT NULL,
        "status" character varying NOT NULL DEFAULT 'active',
        "rejection_reason" character varying,
        "applied_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "stage_changed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "hired_at" TIMESTAMP WITH TIME ZONE,
        "rejected_at" TIMESTAMP WITH TIME ZONE,
        "owner_id" character varying(24),
        "created_by" character varying(24),
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_candidate_applications" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE INDEX "ix_cand_apps_org_opening" ON "candidate_applications" ("organization_id", "opening_id", "stage_id")`);
    await q.query(`CREATE INDEX "ix_cand_apps_candidate" ON "candidate_applications" ("organization_id", "candidate_id")`);
    await q.query(`CREATE UNIQUE INDEX "ux_cand_apps_candidate_opening" ON "candidate_applications" ("organization_id", "candidate_id", "opening_id") WHERE "is_deleted" = false`);

    await q.query(`
      CREATE TABLE "application_stage_events" (${BASE}
        "application_id" character varying(24) NOT NULL,
        "from_stage_id" character varying(24),
        "to_stage_id" character varying(24) NOT NULL,
        "by_user_id" character varying(24),
        "note" text,
        "at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_application_stage_events" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE INDEX "ix_app_stage_events_app" ON "application_stage_events" ("organization_id", "application_id")`);
    await q.query(`CREATE INDEX "ix_app_stage_events_org_at" ON "application_stage_events" ("organization_id", "at")`);

    await q.query(`
      CREATE TABLE "recruitment_interviews" (${BASE}
        "application_id" character varying(24) NOT NULL,
        "candidate_id" character varying(24) NOT NULL,
        "opening_id" character varying(24) NOT NULL,
        "round_name" character varying NOT NULL,
        "type" character varying NOT NULL DEFAULT 'video',
        "scheduled_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "duration_min" integer NOT NULL DEFAULT 60,
        "interviewer_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "location" character varying,
        "meeting_link" character varying,
        "meeting_id" character varying(24),
        "criteria" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "notes" text,
        "status" character varying NOT NULL DEFAULT 'scheduled',
        "feedback_reminded_at" TIMESTAMP WITH TIME ZONE,
        "created_by" character varying(24),
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_recruitment_interviews" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE INDEX "ix_rec_interviews_org_time" ON "recruitment_interviews" ("organization_id", "scheduled_at")`);
    await q.query(`CREATE INDEX "ix_rec_interviews_app" ON "recruitment_interviews" ("organization_id", "application_id")`);
    await q.query(`CREATE INDEX "ix_rec_interviews_interviewers" ON "recruitment_interviews" USING GIN ("interviewer_ids")`);

    await q.query(`
      CREATE TABLE "recruitment_interview_feedback" (${BASE}
        "interview_id" character varying(24) NOT NULL,
        "interviewer_id" character varying(24) NOT NULL,
        "ratings" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "overall_rating" numeric(3,2),
        "recommendation" character varying NOT NULL,
        "strengths" text,
        "concerns" text,
        "notes" text,
        "submitted_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_recruitment_interview_feedback" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE INDEX "ix_rec_feedback_interview" ON "recruitment_interview_feedback" ("organization_id", "interview_id")`);
    await q.query(`CREATE UNIQUE INDEX "ux_rec_feedback_interviewer" ON "recruitment_interview_feedback" ("interview_id", "interviewer_id")`);

    await q.query(`
      CREATE TABLE "recruitment_scorecard_templates" (${BASE}
        "name" character varying NOT NULL,
        "criteria" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "is_default" boolean NOT NULL DEFAULT false,
        "created_by" character varying(24),
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_recruitment_scorecard_templates" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE INDEX "ix_rec_scorecards_org" ON "recruitment_scorecard_templates" ("organization_id")`);

    await q.query(`
      CREATE TABLE "candidate_offers" (${BASE}
        "application_id" character varying(24) NOT NULL,
        "candidate_id" character varying(24) NOT NULL,
        "opening_id" character varying(24) NOT NULL,
        "designation" character varying NOT NULL,
        "department_id" character varying(24),
        "offered_ctc" numeric(14,2),
        "currency" character varying NOT NULL DEFAULT 'INR',
        "joining_date" date,
        "expires_on" date,
        "status" character varying NOT NULL DEFAULT 'draft',
        "offer_letter_file_id" character varying(24),
        "notes" text,
        "decline_reason" character varying,
        "sent_at" TIMESTAMP WITH TIME ZONE,
        "responded_at" TIMESTAMP WITH TIME ZONE,
        "membership_id" character varying(24),
        "handed_off_at" TIMESTAMP WITH TIME ZONE,
        "created_by" character varying(24),
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_candidate_offers" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE INDEX "ix_cand_offers_org_status" ON "candidate_offers" ("organization_id", "status")`);
    await q.query(`CREATE INDEX "ix_cand_offers_app" ON "candidate_offers" ("organization_id", "application_id")`);

    await q.query(`
      CREATE TABLE "candidate_activities" (${BASE}
        "candidate_id" character varying(24) NOT NULL,
        "application_id" character varying(24),
        "type" character varying NOT NULL,
        "body" text,
        "meta" jsonb,
        "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "by_user_id" character varying(24),
        "by_user_name" character varying,
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_candidate_activities" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE INDEX "ix_cand_activities_candidate" ON "candidate_activities" ("organization_id", "candidate_id", "occurred_at")`);

    await q.query(`
      CREATE TABLE "recruitment_settings" (${BASE}
        "rejection_reasons" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "feedback_reminder_hours" integer NOT NULL DEFAULT 2,
        CONSTRAINT "pk_recruitment_settings" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE UNIQUE INDEX "ux_rec_settings_org" ON "recruitment_settings" ("organization_id")`);

    // Grant the new resource to existing full-access and HR roles (new orgs get it
    // from default-roles.ts). Idempotent: skips roles that already list it.
    await q.query(
      `UPDATE "roles" SET "permissions" = "permissions" || $1::jsonb
       WHERE "name" IN ('owner', 'admin', 'hr')
         AND NOT ("permissions" @> '[{"resource":"recruitment"}]'::jsonb)`,
      [RECRUITMENT_PERMISSION],
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `UPDATE "roles" SET "permissions" = COALESCE((
         SELECT jsonb_agg(p) FROM jsonb_array_elements("permissions") p WHERE p->>'resource' <> 'recruitment'
       ), '[]'::jsonb)
       WHERE "permissions" @> '[{"resource":"recruitment"}]'::jsonb`,
    );
    for (const t of [
      'recruitment_settings', 'candidate_activities', 'candidate_offers', 'recruitment_scorecard_templates',
      'recruitment_interview_feedback', 'recruitment_interviews', 'application_stage_events', 'candidate_applications',
      'candidate_documents', 'candidates', 'recruitment_stages', 'recruitment_openings',
    ]) {
      await q.query(`DROP TABLE IF EXISTS "${t}"`);
    }
  }
}
