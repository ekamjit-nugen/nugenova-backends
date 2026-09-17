import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-org choice of which roles receive which emails.
 *
 * `email_routing` is `{ [emailKey]: { [audience]: boolean } }`, where an audience
 * is `tier:owner`, `tier:admin`, `role:<roleId>` or `norole`. Only the choices an
 * admin actually changed are stored; everything else falls back to the email's
 * default (team emails → owners and admins, personal emails → everyone). An empty
 * object therefore means "defaults everywhere", which is what every existing org
 * gets.
 */
export class EmailRouting1788510000000 implements MigrationInterface {
  name = 'EmailRouting1788510000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "org_notification_settings" ADD COLUMN IF NOT EXISTS "email_routing" jsonb NOT NULL DEFAULT '{}'::jsonb`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "org_notification_settings" DROP COLUMN IF EXISTS "email_routing"`);
  }
}
