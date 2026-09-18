import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Vendor bills — what a vendor charged us for the people they supplied.
 *
 * The unique index on (organization_id, bill_number) is load-bearing: bill
 * numbers are allocated as count+1 (the house pattern), so the index is what
 * makes two concurrent raises fail loudly instead of silently sharing a number.
 */
export class VendorBills1788550000000 implements MigrationInterface {
  name = 'VendorBills1788550000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "vendor_bills" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "vendor_id" character varying(24) NOT NULL,
        "vendor_name" character varying,
        "bill_number" character varying NOT NULL,
        "vendor_invoice_number" character varying,
        "period" character varying,
        "line_items" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "currency" character varying NOT NULL DEFAULT 'INR',
        "subtotal" numeric(14,2) NOT NULL DEFAULT 0,
        "tax_percent" numeric(6,3) NOT NULL DEFAULT 0,
        "tax_amount" numeric(14,2) NOT NULL DEFAULT 0,
        "total" numeric(14,2) NOT NULL DEFAULT 0,
        "status" character varying NOT NULL DEFAULT 'draft',
        "issue_date" TIMESTAMP WITH TIME ZONE,
        "due_date" TIMESTAMP WITH TIME ZONE,
        "approved_at" TIMESTAMP WITH TIME ZONE,
        "approved_by" character varying(24),
        "paid_at" TIMESTAMP WITH TIME ZONE,
        "paid_by" character varying(24),
        "payment_reference" character varying,
        "cancel_reason" text,
        "invoice_file_id" character varying(24),
        "notes" text,
        "created_by" character varying(24),
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_vendor_bills" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "ix_vendor_bills_org_status" ON "vendor_bills" ("organization_id", "status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "ix_vendor_bills_vendor" ON "vendor_bills" ("vendor_id")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "ux_vendor_bills_org_number" ON "vendor_bills" ("organization_id", "bill_number")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "vendor_bills"`);
  }
}
