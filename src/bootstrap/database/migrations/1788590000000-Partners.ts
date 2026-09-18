import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Merge `clients` and `vendors` into one `partners` table with a `category`.
 *
 * The two had grown the same spine — profile, contacts, portal access,
 * documents, agreements — and differed only in which way people flow: we supply
 * people to a client, a vendor supplies people to us. One table with a
 * discriminator keeps that difference explicit and stops the two drifting apart.
 *
 * **Ids are preserved**, so every child row (documents, agreements, bills,
 * tickets, board shares, assignments, contacts) still resolves without being
 * touched. The old tables are renamed rather than dropped, so this is
 * reversible while the code settles.
 */
export class Partners1788590000000 implements MigrationInterface {
  name = 'Partners1788590000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // A client id and a vendor id sharing a value would silently merge two
    // companies; refuse rather than corrupt.
    const [{ collisions }] = await queryRunner.query(
      `SELECT count(*)::int AS collisions FROM "clients" c JOIN "vendors" v ON v."id" = c."id"`,
    );
    if (collisions > 0) {
      throw new Error(`Cannot merge: ${collisions} id(s) exist in both clients and vendors`);
    }

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "partners" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "category" character varying,
        "company_name" character varying NOT NULL,
        "display_name" character varying,
        "website" character varying,
        "status" character varying NOT NULL DEFAULT 'active',
        "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "notes" text,
        "primary_contact" jsonb,
        "portal_enabled" boolean NOT NULL DEFAULT false,
        "created_by" character varying(24),
        "updated_by" character varying(24),
        "is_deleted" boolean NOT NULL DEFAULT false,
        -- client-only
        "industry" character varying,
        -- vendor-only
        "service_category" character varying DEFAULT 'other',
        "tax_id" character varying,
        "currency" character varying DEFAULT 'INR',
        "onboarding_status" character varying DEFAULT 'invited',
        "onboarded_at" TIMESTAMP WITH TIME ZONE,
        "time_tracking_enabled" boolean DEFAULT false,
        "billing_address" jsonb,
        CONSTRAINT "pk_partners" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "ix_partners_org_category" ON "partners" ("organization_id", "category")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "ix_partners_org_deleted" ON "partners" ("organization_id", "is_deleted")`);

    await queryRunner.query(`
      INSERT INTO "partners" (
        "id", "created_at", "updated_at", "organization_id", "category", "company_name", "display_name",
        "website", "status", "tags", "notes", "primary_contact", "portal_enabled", "created_by", "updated_by",
        "is_deleted", "industry"
      )
      SELECT
        "id", "created_at", "updated_at", "organization_id", 'client', "company_name", "display_name",
        "website", "status", "tags", "notes", "primary_contact", "portal_enabled", "created_by", "updated_by",
        "is_deleted", "industry"
      FROM "clients"
      ON CONFLICT ("id") DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO "partners" (
        "id", "created_at", "updated_at", "organization_id", "category", "company_name", "display_name",
        "website", "status", "tags", "notes", "primary_contact", "portal_enabled", "created_by", "updated_by",
        "is_deleted", "service_category", "tax_id", "currency", "onboarding_status", "onboarded_at",
        "time_tracking_enabled", "billing_address"
      )
      SELECT
        "id", "created_at", "updated_at", "organization_id", 'vendor', "company_name", "display_name",
        "website", "status", "tags", "notes", "primary_contact", "portal_enabled", "created_by", "updated_by",
        "is_deleted", "service_category", "tax_id", "currency", "onboarding_status", "onboarded_at",
        "time_tracking_enabled", "billing_address"
      FROM "vendors"
      ON CONFLICT ("id") DO NOTHING
    `);

    // Kept, not dropped: a rollback path while the merged code settles.
    await queryRunner.query(`ALTER TABLE "clients" RENAME TO "clients_premerge"`);
    await queryRunner.query(`ALTER TABLE "vendors" RENAME TO "vendors_premerge"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE IF EXISTS "clients_premerge" RENAME TO "clients"`);
    await queryRunner.query(`ALTER TABLE IF EXISTS "vendors_premerge" RENAME TO "vendors"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "partners"`);
  }
}
