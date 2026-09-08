import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI runtime metering (§15 "AI credits").
 *
 * Two tables:
 *   - `ai_usage_events`   — append-only ledger, one row per LLM call (org, user,
 *     provider, model, tokens, estimated USD cost, purpose, prompt/output audit).
 *   - `ai_usage_counters` — pre-aggregated per-(org, period) rollup, the O(1)
 *     "credit balance" surface, upsert-incremented on every recorded call.
 *
 * Postgres port of the Mongo `ai_usage_events` / `ai_usage_counters`
 * collections. `cost_usd` is populated here (the default provider, Claude, is
 * hosted + per-token-priced) rather than left null as in the self-hosted Mongo
 * original.
 */
export class AiUsage1788090000000 implements MigrationInterface {
  name = 'AiUsage1788090000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "ai_usage_events" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24),
        "user_id" character varying(24),
        "feature" character varying NOT NULL DEFAULT 'other',
        "provider" character varying NOT NULL DEFAULT 'anthropic',
        "model" character varying NOT NULL,
        "prompt_tokens" integer NOT NULL DEFAULT 0,
        "completion_tokens" integer NOT NULL DEFAULT 0,
        "total_tokens" integer NOT NULL DEFAULT 0,
        "cost_usd" numeric(12,6) NOT NULL DEFAULT 0,
        "streamed" boolean NOT NULL DEFAULT false,
        "status" character varying NOT NULL DEFAULT 'success',
        "prompt" text,
        "output" text,
        CONSTRAINT "PK_ai_usage_events" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_ai_usage_events_org_created" ON "ai_usage_events" ("organization_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_ai_usage_events_org_user" ON "ai_usage_events" ("organization_id", "user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_ai_usage_events_org_feature" ON "ai_usage_events" ("organization_id", "feature")`,
    );

    await queryRunner.query(`
      CREATE TABLE "ai_usage_counters" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "period" character varying(7) NOT NULL,
        "prompt_tokens" bigint NOT NULL DEFAULT 0,
        "completion_tokens" bigint NOT NULL DEFAULT 0,
        "total_tokens" bigint NOT NULL DEFAULT 0,
        "cost_usd" numeric(14,6) NOT NULL DEFAULT 0,
        "request_count" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_ai_usage_counters" PRIMARY KEY ("id")
      )
    `);
    // Unique per (org, period) — also the ON CONFLICT target for the atomic
    // upsert-increment in AiUsageService.record.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_ai_usage_counters_org_period" ON "ai_usage_counters" ("organization_id", "period")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."uq_ai_usage_counters_org_period"`);
    await queryRunner.query(`DROP TABLE "ai_usage_counters"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."ix_ai_usage_events_org_feature"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."ix_ai_usage_events_org_user"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."ix_ai_usage_events_org_created"`);
    await queryRunner.query(`DROP TABLE "ai_usage_events"`);
  }
}
