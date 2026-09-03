import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-event granularity for the org notification policy: `employee_types` jsonb
 * holds per-notification-type channel overrides that win over the per-category
 * default. Empty = fall back to the category, so existing settings are unchanged.
 */
export class OrgNotificationTypes1788010000000 implements MigrationInterface {
  name = 'OrgNotificationTypes1788010000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "org_notification_settings" ADD "employee_types" jsonb NOT NULL DEFAULT '{}'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "org_notification_settings" DROP COLUMN "employee_types"`);
  }
}
