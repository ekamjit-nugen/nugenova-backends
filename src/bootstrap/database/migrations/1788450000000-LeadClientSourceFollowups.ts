import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Leads can come from an existing client (`source = 'client'` + `source_client_id`),
 * carry source-specific details (`source_meta`, e.g. referrer or event), and follow-ups record whose court the ball is in (`waiting_on`: client | us).
 */
export class LeadClientSourceFollowups1788450000000 implements MigrationInterface {
  name = 'LeadClientSourceFollowups1788450000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "source_client_id" character varying(24)`);
    await q.query(`CREATE INDEX IF NOT EXISTS "ix_leads_org_source_client" ON "leads" ("organization_id", "source_client_id") WHERE "source_client_id" IS NOT NULL`);
    await q.query(`ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "source_meta" jsonb`);
    await q.query(`ALTER TABLE "sales_followups" ADD COLUMN IF NOT EXISTS "waiting_on" character varying`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "sales_followups" DROP COLUMN IF EXISTS "waiting_on"`);
    await q.query(`ALTER TABLE "leads" DROP COLUMN IF EXISTS "source_meta"`);
    await q.query(`DROP INDEX IF EXISTS "ix_leads_org_source_client"`);
    await q.query(`ALTER TABLE "leads" DROP COLUMN IF EXISTS "source_client_id"`);
  }
}
