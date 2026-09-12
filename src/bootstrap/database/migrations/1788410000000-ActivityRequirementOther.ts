import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Free-text labels for the "Other" option on activity type and requirement unit,
 * mirroring leads.source_detail.
 */
export class ActivityRequirementOther1788410000000 implements MigrationInterface {
  name = 'ActivityRequirementOther1788410000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "sales_activities" ADD COLUMN IF NOT EXISTS "type_detail" character varying`);
    await q.query(`ALTER TABLE "sales_requirements" ADD COLUMN IF NOT EXISTS "unit_detail" character varying`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "sales_requirements" DROP COLUMN IF EXISTS "unit_detail"`);
    await q.query(`ALTER TABLE "sales_activities" DROP COLUMN IF EXISTS "type_detail"`);
  }
}
