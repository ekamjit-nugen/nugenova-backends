import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Reusable agreement templates + reminder tracking on agreements (last reminder
 * timestamp + count, for the manual "nudge" button and the auto-reminder cron).
 */
export class ClientAgreementTemplatesReminders1788340000000 implements MigrationInterface {
  name = 'ClientAgreementTemplatesReminders1788340000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "client_agreements" ADD COLUMN IF NOT EXISTS "last_reminder_at" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "client_agreements" ADD COLUMN IF NOT EXISTS "reminder_count" integer NOT NULL DEFAULT 0`);

    await queryRunner.query(`
      CREATE TABLE "client_agreement_templates" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "name" character varying NOT NULL,
        "title" character varying,
        "category" character varying NOT NULL DEFAULT 'other',
        "body_html" text,
        "source_file_id" character varying(24),
        "fields" jsonb,
        "created_by" character varying(24),
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_client_agreement_templates" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "ix_client_agreement_templates_org" ON "client_agreement_templates" ("organization_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "client_agreement_templates"`);
    await queryRunner.query(`ALTER TABLE "client_agreements" DROP COLUMN IF EXISTS "reminder_count"`);
    await queryRunner.query(`ALTER TABLE "client_agreements" DROP COLUMN IF EXISTS "last_reminder_at"`);
  }
}
