import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sales Phase 4 — lead-centric model. The separate "deal" record is removed:
 * the lead becomes the single record carrying the requirement write-up, docs,
 * amount, structured effort, quotes, and the Won→Client bridge.
 *
 * - Adds `leads.requirement` (rich-text HTML) + `leads.won_at`.
 * - Drops the now-unused `leads.converted_to_deal_id` / `leads.converted_at`.
 * - Creates `sales_lead_documents`.
 * - Re-points any deal-scoped requirements/quotes/activities/follow-ups onto
 *   nothing (deletes them) and drops the `deals` table.
 */
export class SalesPhase4LeadCentric1788390000000 implements MigrationInterface {
  name = 'SalesPhase4LeadCentric1788390000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "requirement" text`);
    await q.query(`ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "won_at" TIMESTAMP WITH TIME ZONE`);
    await q.query(`ALTER TABLE "leads" DROP COLUMN IF EXISTS "converted_to_deal_id"`);
    await q.query(`ALTER TABLE "leads" DROP COLUMN IF EXISTS "converted_at"`);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "sales_lead_documents" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "lead_id" character varying(24) NOT NULL,
        "file_id" character varying(24) NOT NULL,
        "file_name" character varying NOT NULL,
        "mime_type" character varying,
        "size" bigint,
        "title" character varying,
        "created_by" character varying(24),
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_sales_lead_documents" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE INDEX IF NOT EXISTS "ix_sales_lead_documents_lead" ON "sales_lead_documents" ("organization_id", "lead_id")`);

    // The polymorphic children only ever attach to leads now — drop deal-scoped rows.
    await q.query(`DELETE FROM "sales_requirements" WHERE "entity_type" = 'deal'`);
    await q.query(`DELETE FROM "sales_quotes" WHERE "entity_type" = 'deal'`);
    await q.query(`DELETE FROM "sales_activities" WHERE "entity_type" = 'deal'`);
    await q.query(`DELETE FROM "sales_followups" WHERE "entity_type" = 'deal'`);

    await q.query(`DROP TABLE IF EXISTS "deals"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    // Recreate the deals table (structure from SalesPhase2) so a rollback restores schema.
    await q.query(`
      CREATE TABLE IF NOT EXISTS "deals" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "title" character varying NOT NULL,
        "account_id" character varying(24),
        "contact_id" character varying(24),
        "source_lead_id" character varying(24),
        "stage_id" character varying(24),
        "status" character varying NOT NULL DEFAULT 'open',
        "amount" numeric(14,2),
        "currency" character varying NOT NULL DEFAULT 'INR',
        "assigned_to" character varying(24),
        "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "notes" text,
        "expected_close_date" TIMESTAMP WITH TIME ZONE,
        "last_activity_at" TIMESTAMP WITH TIME ZONE,
        "next_follow_up_at" TIMESTAMP WITH TIME ZONE,
        "won_at" TIMESTAMP WITH TIME ZONE,
        "lost_at" TIMESTAMP WITH TIME ZONE,
        "lost_reason" character varying,
        "client_id" character varying(24),
        "created_by" character varying(24),
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_deals" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE INDEX IF NOT EXISTS "ix_deals_org_status" ON "deals" ("organization_id", "status")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "ix_deals_org_stage" ON "deals" ("organization_id", "stage_id")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "ix_deals_org_assigned" ON "deals" ("organization_id", "assigned_to")`);

    await q.query(`DROP TABLE IF EXISTS "sales_lead_documents"`);
    await q.query(`ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "converted_to_deal_id" character varying(24)`);
    await q.query(`ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "converted_at" TIMESTAMP WITH TIME ZONE`);
    await q.query(`ALTER TABLE "leads" DROP COLUMN IF EXISTS "won_at"`);
    await q.query(`ALTER TABLE "leads" DROP COLUMN IF EXISTS "requirement"`);
  }
}
