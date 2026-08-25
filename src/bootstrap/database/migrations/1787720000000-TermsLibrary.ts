import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Terms & Conditions become a LIBRARY (many named documents) that the super
 * admin assigns to orgs at creation, instead of one global versioned document.
 *  - `platform_terms.version` is now PER-DOCUMENT (drop the global-unique index;
 *    give it a default of 1). Each edit bumps that doc's own version.
 *  - `organizations.terms_id` — the T&C document assigned to the org. The org's
 *    `consent` jsonb now also records the accepted `termsId` (no schema change —
 *    it's jsonb).
 *
 * Existing global T&C rows are removed separately (the model is reset).
 */
export class TermsLibrary1787720000000 implements MigrationInterface {
  name = 'TermsLibrary1787720000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."uq_platform_terms_version"`);
    await queryRunner.query(
      `ALTER TABLE "platform_terms" ALTER COLUMN "version" SET DEFAULT 1`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD "terms_id" character varying(24)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_organizations_terms_id" ON "organizations" ("terms_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_organizations_terms_id"`);
    await queryRunner.query(`ALTER TABLE "organizations" DROP COLUMN "terms_id"`);
    await queryRunner.query(
      `ALTER TABLE "platform_terms" ALTER COLUMN "version" DROP DEFAULT`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_platform_terms_version" ON "platform_terms" ("version")`,
    );
  }
}
