import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Org-level notification policy: one row per org holding the owner's per-category
 * per-channel gates for what EMPLOYEES receive (`employee_categories` jsonb).
 * Empty default = everything on, so existing orgs are unaffected.
 */
export class OrgNotificationSettings1788000000000 implements MigrationInterface {
  name = 'OrgNotificationSettings1788000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "org_notification_settings" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "employee_categories" jsonb NOT NULL DEFAULT '{}',
        CONSTRAINT "PK_org_notification_settings" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_org_notification_settings_org" ON "org_notification_settings" ("organization_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."uq_org_notification_settings_org"`);
    await queryRunner.query(`DROP TABLE "org_notification_settings"`);
  }
}
