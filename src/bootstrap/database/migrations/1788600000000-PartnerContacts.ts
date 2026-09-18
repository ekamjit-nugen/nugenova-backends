import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Merge `client_contacts` and `vendor_contacts` into one `partner_contacts`
 * table, the same way `partners` merged the two company tables.
 *
 * Both `client_id` and `vendor_id` are kept because the two services still name
 * the owning company differently in code; `partner_id` is a generated column
 * over the pair, which is what a combined query reads. When the services move to
 * the shared name, the two columns collapse into it.
 *
 * Ids are preserved, so anything referencing a contact (portal logins link back
 * through `user_id`) still resolves. The old tables are renamed, not dropped.
 */
export class PartnerContacts1788600000000 implements MigrationInterface {
  name = 'PartnerContacts1788600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const [{ collisions }] = await queryRunner.query(
      `SELECT count(*)::int AS collisions FROM "client_contacts" c JOIN "vendor_contacts" v ON v."id" = c."id"`,
    );
    if (collisions > 0) {
      throw new Error(`Cannot merge: ${collisions} contact id(s) exist in both client_contacts and vendor_contacts`);
    }

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "partner_contacts" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "category" character varying,
        "client_id" character varying(24),
        "vendor_id" character varying(24),
        "partner_id" character varying(24) GENERATED ALWAYS AS (COALESCE("client_id", "vendor_id")) STORED,
        "name" character varying NOT NULL,
        "email" character varying,
        "phone" character varying,
        "designation" character varying,
        "is_primary" boolean DEFAULT false,
        "user_id" character varying(24),
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_partner_contacts" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "ix_partner_contacts_org" ON "partner_contacts" ("organization_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "ix_partner_contacts_partner" ON "partner_contacts" ("partner_id")`);

    await queryRunner.query(`
      INSERT INTO "partner_contacts" (
        "id", "created_at", "updated_at", "organization_id", "category", "client_id",
        "name", "email", "phone", "designation", "user_id", "is_deleted"
      )
      SELECT
        "id", "created_at", "updated_at", "organization_id", 'client', "client_id",
        "name", "email", "phone", "designation", "user_id", "is_deleted"
      FROM "client_contacts"
      ON CONFLICT ("id") DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO "partner_contacts" (
        "id", "created_at", "updated_at", "organization_id", "category", "vendor_id",
        "name", "email", "phone", "designation", "is_primary", "user_id", "is_deleted"
      )
      SELECT
        "id", "created_at", "updated_at", "organization_id", 'vendor', "vendor_id",
        "name", "email", "phone", "designation", "is_primary", "user_id", "is_deleted"
      FROM "vendor_contacts"
      ON CONFLICT ("id") DO NOTHING
    `);

    await queryRunner.query(`ALTER TABLE "client_contacts" RENAME TO "client_contacts_premerge"`);
    await queryRunner.query(`ALTER TABLE "vendor_contacts" RENAME TO "vendor_contacts_premerge"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE IF EXISTS "client_contacts_premerge" RENAME TO "client_contacts"`);
    await queryRunner.query(`ALTER TABLE IF EXISTS "vendor_contacts_premerge" RENAME TO "vendor_contacts"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "partner_contacts"`);
  }
}
