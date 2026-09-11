import { MigrationInterface, QueryRunner } from 'typeorm';

/** Sales Phase 3: quotes/proposals (line items → totals) for leads and deals. */
export class SalesPhase3Quotes1788380000000 implements MigrationInterface {
  name = 'SalesPhase3Quotes1788380000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "sales_quotes" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "entity_type" character varying NOT NULL,
        "entity_id" character varying(24) NOT NULL,
        "number" character varying,
        "title" character varying NOT NULL,
        "status" character varying NOT NULL DEFAULT 'draft',
        "currency" character varying NOT NULL DEFAULT 'INR',
        "items" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "discount_type" character varying NOT NULL DEFAULT 'percent',
        "discount_value" numeric(14,2) NOT NULL DEFAULT 0,
        "tax_percent" numeric(6,3) NOT NULL DEFAULT 0,
        "notes" text,
        "subtotal" numeric(14,2) NOT NULL DEFAULT 0,
        "discount_amount" numeric(14,2) NOT NULL DEFAULT 0,
        "tax_amount" numeric(14,2) NOT NULL DEFAULT 0,
        "total" numeric(14,2) NOT NULL DEFAULT 0,
        "valid_until" TIMESTAMP WITH TIME ZONE,
        "sent_at" TIMESTAMP WITH TIME ZONE,
        "accepted_at" TIMESTAMP WITH TIME ZONE,
        "rejected_at" TIMESTAMP WITH TIME ZONE,
        "created_by" character varying(24),
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_sales_quotes" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE INDEX "ix_sales_quotes_entity" ON "sales_quotes" ("organization_id", "entity_type", "entity_id")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "sales_quotes"`);
  }
}
