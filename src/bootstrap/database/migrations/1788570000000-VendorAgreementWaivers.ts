import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Waiving a required vendor agreement: the vendor is cleared without that
 * signature, and the record says who decided it and why. Nothing is waived by
 * default, so existing agreements keep blocking clearance exactly as before.
 */
export class VendorAgreementWaivers1788570000000 implements MigrationInterface {
  name = 'VendorAgreementWaivers1788570000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vendor_agreements" ADD COLUMN IF NOT EXISTS "waived" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "vendor_agreements" ADD COLUMN IF NOT EXISTS "waived_reason" text`);
    await queryRunner.query(`ALTER TABLE "vendor_agreements" ADD COLUMN IF NOT EXISTS "waived_at" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "vendor_agreements" ADD COLUMN IF NOT EXISTS "waived_by" character varying(24)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const col of ['waived_by', 'waived_at', 'waived_reason', 'waived']) {
      await queryRunner.query(`ALTER TABLE "vendor_agreements" DROP COLUMN IF EXISTS "${col}"`);
    }
  }
}
