import { MigrationInterface, QueryRunner } from 'typeorm';

/** Free-text label for a lead's source when `source` is 'other'. */
export class LeadSourceDetail1788400000000 implements MigrationInterface {
  name = 'LeadSourceDetail1788400000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "source_detail" character varying`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "leads" DROP COLUMN IF EXISTS "source_detail"`);
  }
}
