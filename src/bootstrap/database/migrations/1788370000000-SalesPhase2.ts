import { MigrationInterface, QueryRunner } from 'typeorm';

/** Sales Phase 2: deals/opportunities + requirements with effort estimation. */
export class SalesPhase21788370000000 implements MigrationInterface {
  name = 'SalesPhase21788370000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "deals" (
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
    await q.query(`CREATE INDEX "ix_deals_org_status" ON "deals" ("organization_id", "status")`);
    await q.query(`CREATE INDEX "ix_deals_org_stage" ON "deals" ("organization_id", "stage_id")`);
    await q.query(`CREATE INDEX "ix_deals_org_assigned" ON "deals" ("organization_id", "assigned_to")`);

    await q.query(`
      CREATE TABLE "sales_requirements" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "entity_type" character varying NOT NULL,
        "entity_id" character varying(24) NOT NULL,
        "title" character varying NOT NULL,
        "details" text,
        "category" character varying,
        "role" character varying,
        "skills" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "priority" character varying NOT NULL DEFAULT 'must_have',
        "status" character varying NOT NULL DEFAULT 'open',
        "unit" character varying NOT NULL DEFAULT 'hours',
        "quantity" numeric(12,2) NOT NULL DEFAULT 0,
        "rate" numeric(14,2) NOT NULL DEFAULT 0,
        "needed_by" TIMESTAMP WITH TIME ZONE,
        "assigned_to" character varying(24),
        "created_by" character varying(24),
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_sales_requirements" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE INDEX "ix_sales_requirements_entity" ON "sales_requirements" ("organization_id", "entity_type", "entity_id")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "sales_requirements"`);
    await q.query(`DROP TABLE IF EXISTS "deals"`);
  }
}
