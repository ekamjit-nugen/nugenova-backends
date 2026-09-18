import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Vendor agreements — the org's reusable templates (MSA, NDA, code of conduct)
 * and the copy each vendor signs. A required template that applies to a vendor
 * must be signed before the vendor is cleared to supply people, which is what
 * `vendors.onboarding_status` follows.
 */
export class VendorAgreements1788540000000 implements MigrationInterface {
  name = 'VendorAgreements1788540000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "vendor_agreement_templates" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "name" character varying NOT NULL,
        "title" character varying,
        "category" character varying NOT NULL DEFAULT 'other',
        "body_html" text,
        "source_file_id" character varying(24),
        "fields" jsonb,
        "required" boolean NOT NULL DEFAULT false,
        "applies_to_categories" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "is_archived" boolean NOT NULL DEFAULT false,
        "created_by" character varying(24),
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_vendor_agreement_templates" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "ix_vendor_agreement_templates_org" ON "vendor_agreement_templates" ("organization_id")`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "vendor_agreements" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "vendor_id" character varying(24) NOT NULL,
        "template_id" character varying(24),
        "title" character varying NOT NULL,
        "description" text,
        "category" character varying NOT NULL DEFAULT 'other',
        "body_html" text,
        "source_file_id" character varying(24),
        "fields" jsonb,
        "signed_file_id" character varying(24),
        "status" character varying NOT NULL DEFAULT 'draft',
        "required_for_onboarding" boolean NOT NULL DEFAULT false,
        "signature" jsonb,
        "sent_at" TIMESTAMP WITH TIME ZONE,
        "signed_at" TIMESTAMP WITH TIME ZONE,
        "decline_reason" text,
        "expires_at" TIMESTAMP WITH TIME ZONE,
        "created_by" character varying(24),
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_vendor_agreements" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "ix_vendor_agreements_org" ON "vendor_agreements" ("organization_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "ix_vendor_agreements_vendor" ON "vendor_agreements" ("vendor_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "vendor_agreements"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "vendor_agreement_templates"`);
  }
}
