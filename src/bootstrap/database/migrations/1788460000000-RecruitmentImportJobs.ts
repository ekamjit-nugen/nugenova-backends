import { MigrationInterface, QueryRunner } from 'typeorm';

const BASE = `
  "id" character varying(24) NOT NULL,
  "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  "organization_id" character varying(24) NOT NULL,`;

/**
 * Background spreadsheet imports. The request stores the rows and returns at
 * once; a worker saves each row independently and keeps live counters, so the
 * dashboard can show per-file progress and a crashed or restarted server
 * resumes where it stopped.
 */
export class RecruitmentImportJobs1788460000000 implements MigrationInterface {
  name = 'RecruitmentImportJobs1788460000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "recruitment_import_jobs" (${BASE}
        "created_by" character varying(24) NOT NULL,
        "caller" jsonb NOT NULL,
        "file_name" character varying(255) NOT NULL,
        "file_size" integer,
        "sheet_names" jsonb NOT NULL DEFAULT '[]',
        "idempotency_key" character varying(64),
        "status" character varying NOT NULL DEFAULT 'queued',
        "options" jsonb NOT NULL DEFAULT '{}',
        "total_rows" integer NOT NULL DEFAULT 0,
        "processed_rows" integer NOT NULL DEFAULT 0,
        "created_count" integer NOT NULL DEFAULT 0,
        "merged_count" integer NOT NULL DEFAULT 0,
        "skipped_count" integer NOT NULL DEFAULT 0,
        "error_count" integer NOT NULL DEFAULT 0,
        "flagged_count" integer NOT NULL DEFAULT 0,
        "applications_count" integer NOT NULL DEFAULT 0,
        "submissions_count" integer NOT NULL DEFAULT 0,
        "talent_pool_count" integer NOT NULL DEFAULT 0,
        "openings_created" jsonb NOT NULL DEFAULT '[]',
        "cancel_requested" boolean NOT NULL DEFAULT false,
        "attempts" integer NOT NULL DEFAULT 0,
        "locked_by" character varying(64),
        "heartbeat_at" TIMESTAMP WITH TIME ZONE,
        "started_at" TIMESTAMP WITH TIME ZONE,
        "finished_at" TIMESTAMP WITH TIME ZONE,
        "last_error" text,
        "dismissed_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "pk_recruitment_import_jobs" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE INDEX "ix_rec_import_jobs_org" ON "recruitment_import_jobs" ("organization_id", "created_at")`);
    await q.query(`CREATE INDEX "ix_rec_import_jobs_queue" ON "recruitment_import_jobs" ("status", "created_at")`);
    // A retried "Import" click (double-click, flaky network, second tab) returns the same job instead of importing twice.
    await q.query(`CREATE UNIQUE INDEX "ux_rec_import_jobs_idempotency" ON "recruitment_import_jobs" ("organization_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL`);

    await q.query(`
      CREATE TABLE "recruitment_import_rows" (${BASE}
        "job_id" character varying(24) NOT NULL,
        "idx" integer NOT NULL,
        "sheet" character varying(200),
        "row_number" integer,
        "payload" jsonb NOT NULL,
        "status" character varying NOT NULL DEFAULT 'pending',
        "attempts" integer NOT NULL DEFAULT 0,
        "outcome" character varying,
        "candidate_id" character varying(24),
        "full_name" character varying(300),
        "opening" character varying(200),
        "lead" character varying(300),
        "applied_to_opening" boolean NOT NULL DEFAULT false,
        "submitted_to_lead" boolean NOT NULL DEFAULT false,
        "talent_pool" boolean NOT NULL DEFAULT false,
        "opening_created" boolean NOT NULL DEFAULT false,
        "duplicate" jsonb,
        "messages" jsonb NOT NULL DEFAULT '[]',
        "processed_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "pk_recruitment_import_rows" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE UNIQUE INDEX "ux_rec_import_rows_job_idx" ON "recruitment_import_rows" ("job_id", "idx")`);
    await q.query(`CREATE INDEX "ix_rec_import_rows_status" ON "recruitment_import_rows" ("job_id", "status", "idx")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "recruitment_import_rows"`);
    await q.query(`DROP TABLE IF EXISTS "recruitment_import_jobs"`);
  }
}
