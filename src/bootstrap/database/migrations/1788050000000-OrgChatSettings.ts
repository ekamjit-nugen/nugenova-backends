import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Org-level chat policy: one row per org holding the admin/owner's control over
 * chat for EMPLOYEES (access, attachments, moderation/retention, broadcast) in a
 * single `settings` jsonb. Empty default = the prior permissive behaviour, so
 * existing orgs are unaffected until an admin changes something.
 */
export class OrgChatSettings1788050000000 implements MigrationInterface {
  name = 'OrgChatSettings1788050000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "org_chat_settings" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "settings" jsonb NOT NULL DEFAULT '{}',
        CONSTRAINT "PK_org_chat_settings" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_org_chat_settings_org" ON "org_chat_settings" ("organization_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."uq_org_chat_settings_org"`);
    await queryRunner.query(`DROP TABLE "org_chat_settings"`);
  }
}
