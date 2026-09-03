import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Terms & Conditions become a SINGLE ACTIVE document. Instead of assigning a
 * library doc per org, exactly one `platform_terms` row is `is_active`, and
 * EVERY organization — active or not — must accept it at its current version.
 * Editing the active doc (a new version) or activating a different one re-gates
 * every org at login.
 *
 *  - `platform_terms.is_active` (boolean, default false) with a partial unique
 *    index so at most one row can be active.
 *  - Backfill: if any T&C rows exist, make the most-recently-updated one active
 *    (so an existing library keeps gating without a super-admin action).
 */
export class TermsActive1787980000000 implements MigrationInterface {
  name = 'TermsActive1787980000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "platform_terms" ADD "is_active" boolean NOT NULL DEFAULT false`,
    );
    // Promote the newest existing document to active, if the library isn't empty.
    await queryRunner.query(`
      UPDATE "platform_terms" SET "is_active" = true
      WHERE "id" = (
        SELECT "id" FROM "platform_terms"
        ORDER BY "updated_at" DESC, "created_at" DESC
        LIMIT 1
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_platform_terms_active" ON "platform_terms" ("is_active") WHERE "is_active" = true`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."uq_platform_terms_active"`);
    await queryRunner.query(`ALTER TABLE "platform_terms" DROP COLUMN "is_active"`);
  }
}
