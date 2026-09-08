import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI chatbot — async, RAG-grounded, multi-turn conversations.
 *
 * Three tables:
 *   - `ai_conversations` — one multi-turn thread, owned by a single (org, user).
 *   - `ai_messages`      — the turns; a `user` turn is complete on insert, an
 *     `assistant` turn starts `pending` and is filled in by the background
 *     worker (content/sources/grounded, status → done|error).
 *   - `ai_jobs`          — DB-backed background job rows executed IN-PROCESS
 *     (no Redis/BullMQ): queued → running → done|error. A restart orphans
 *     in-flight rows; the app reaps stale queued/running rows on boot.
 *
 * Everything is scoped by `organization_id` + `user_id` so a user only ever
 * reaches their own threads.
 */
export class AiChat1788140000000 implements MigrationInterface {
  name = 'AiChat1788140000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── ai_conversations ──
    await queryRunner.query(`
      CREATE TABLE "ai_conversations" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24),
        "user_id" character varying(24) NOT NULL,
        "title" character varying,
        "last_message_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_ai_conversations" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_ai_conversations_org_user" ON "ai_conversations" ("organization_id", "user_id")`,
    );

    // ── ai_messages ──
    await queryRunner.query(`
      CREATE TABLE "ai_messages" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "conversation_id" character varying(24) NOT NULL,
        "organization_id" character varying(24),
        "role" character varying NOT NULL DEFAULT 'user',
        "content" text NOT NULL DEFAULT '',
        "sources" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "grounded" boolean NOT NULL DEFAULT false,
        "status" character varying NOT NULL DEFAULT 'done',
        "error_message" text,
        "job_id" character varying(24),
        CONSTRAINT "PK_ai_messages" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_ai_messages_conv_created" ON "ai_messages" ("conversation_id", "created_at")`,
    );

    // ── ai_jobs ──
    await queryRunner.query(`
      CREATE TABLE "ai_jobs" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24),
        "user_id" character varying(24) NOT NULL,
        "kind" character varying NOT NULL DEFAULT 'chat',
        "status" character varying NOT NULL DEFAULT 'queued',
        "input" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "result" jsonb,
        "error_message" text,
        "completed_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_ai_jobs" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_ai_jobs_org_user" ON "ai_jobs" ("organization_id", "user_id")`,
    );
    // Orphan sweep on boot scans by (status, created_at).
    await queryRunner.query(
      `CREATE INDEX "ix_ai_jobs_status_created" ON "ai_jobs" ("status", "created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."ix_ai_jobs_status_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."ix_ai_jobs_org_user"`);
    await queryRunner.query(`DROP TABLE "ai_jobs"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."ix_ai_messages_conv_created"`);
    await queryRunner.query(`DROP TABLE "ai_messages"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."ix_ai_conversations_org_user"`);
    await queryRunner.query(`DROP TABLE "ai_conversations"`);
  }
}
