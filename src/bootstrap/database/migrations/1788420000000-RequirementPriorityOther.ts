import { MigrationInterface, QueryRunner } from 'typeorm';

/** Free-text label for the "Other" option on requirement priority. */
export class RequirementPriorityOther1788420000000 implements MigrationInterface {
  name = 'RequirementPriorityOther1788420000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "sales_requirements" ADD COLUMN IF NOT EXISTS "priority_detail" character varying`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "sales_requirements" DROP COLUMN IF EXISTS "priority_detail"`);
  }
}
