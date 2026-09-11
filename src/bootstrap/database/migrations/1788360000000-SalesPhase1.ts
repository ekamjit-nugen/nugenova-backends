import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sales & Leads — Phase 1: pipeline stages, leads, accounts, contacts, and the
 * shared activity/follow-up timeline.
 */
export class SalesPhase11788360000000 implements MigrationInterface {
  name = 'SalesPhase11788360000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "sales_pipeline_stages" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "name" character varying NOT NULL,
        "order" integer NOT NULL,
        "is_won" boolean NOT NULL DEFAULT false,
        "is_lost" boolean NOT NULL DEFAULT false,
        "probability" integer NOT NULL DEFAULT 0,
        "color" character varying,
        "is_default" boolean NOT NULL DEFAULT false,
        "created_by" character varying(24),
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_sales_pipeline_stages" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE INDEX "ix_sales_stages_org" ON "sales_pipeline_stages" ("organization_id")`);

    await q.query(`
      CREATE TABLE "leads" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "name" character varying NOT NULL,
        "company" character varying,
        "email" character varying,
        "phone" character varying,
        "title" character varying,
        "source" character varying NOT NULL DEFAULT 'other',
        "stage_id" character varying(24),
        "status" character varying NOT NULL DEFAULT 'open',
        "value" numeric(14,2),
        "currency" character varying NOT NULL DEFAULT 'INR',
        "assigned_to" character varying(24),
        "score" integer NOT NULL DEFAULT 0,
        "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "notes" text,
        "last_activity_at" TIMESTAMP WITH TIME ZONE,
        "next_follow_up_at" TIMESTAMP WITH TIME ZONE,
        "converted_to_deal_id" character varying(24),
        "converted_at" TIMESTAMP WITH TIME ZONE,
        "client_id" character varying(24),
        "created_by" character varying(24),
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_leads" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE INDEX "ix_leads_org_status" ON "leads" ("organization_id", "status")`);
    await q.query(`CREATE INDEX "ix_leads_org_stage" ON "leads" ("organization_id", "stage_id")`);
    await q.query(`CREATE INDEX "ix_leads_org_assigned" ON "leads" ("organization_id", "assigned_to")`);

    await q.query(`
      CREATE TABLE "sales_accounts" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "name" character varying NOT NULL,
        "domain" character varying,
        "industry" character varying,
        "size" character varying,
        "website" character varying,
        "phone" character varying,
        "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "assigned_to" character varying(24),
        "created_by" character varying(24),
        "last_activity_at" TIMESTAMP WITH TIME ZONE,
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_sales_accounts" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE INDEX "ix_sales_accounts_org" ON "sales_accounts" ("organization_id")`);

    await q.query(`
      CREATE TABLE "sales_contacts" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "name" character varying NOT NULL,
        "email" character varying,
        "phone" character varying,
        "title" character varying,
        "account_id" character varying(24),
        "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "assigned_to" character varying(24),
        "created_by" character varying(24),
        "last_activity_at" TIMESTAMP WITH TIME ZONE,
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_sales_contacts" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE INDEX "ix_sales_contacts_org" ON "sales_contacts" ("organization_id")`);
    await q.query(`CREATE INDEX "ix_sales_contacts_account" ON "sales_contacts" ("account_id")`);

    await q.query(`
      CREATE TABLE "sales_activities" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "entity_type" character varying NOT NULL,
        "entity_id" character varying(24) NOT NULL,
        "type" character varying NOT NULL,
        "body" text,
        "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "created_by" character varying(24),
        "created_by_name" character varying,
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_sales_activities" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE INDEX "ix_sales_activities_entity" ON "sales_activities" ("organization_id", "entity_type", "entity_id")`);

    await q.query(`
      CREATE TABLE "sales_followups" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "entity_type" character varying NOT NULL,
        "entity_id" character varying(24) NOT NULL,
        "due_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "note" text,
        "status" character varying NOT NULL DEFAULT 'pending',
        "assigned_to" character varying(24),
        "created_by" character varying(24),
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "reminded_at" TIMESTAMP WITH TIME ZONE,
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_sales_followups" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE INDEX "ix_sales_followups_entity" ON "sales_followups" ("organization_id", "entity_type", "entity_id")`);
    await q.query(`CREATE INDEX "ix_sales_followups_due" ON "sales_followups" ("organization_id", "status", "due_at")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "sales_followups"`);
    await q.query(`DROP TABLE IF EXISTS "sales_activities"`);
    await q.query(`DROP TABLE IF EXISTS "sales_contacts"`);
    await q.query(`DROP TABLE IF EXISTS "sales_accounts"`);
    await q.query(`DROP TABLE IF EXISTS "leads"`);
    await q.query(`DROP TABLE IF EXISTS "sales_pipeline_stages"`);
  }
}
