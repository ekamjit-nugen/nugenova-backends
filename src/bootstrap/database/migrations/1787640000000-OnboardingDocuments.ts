import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Onboarding document approval + supporting infra.
 *
 * Adds four tables:
 *  - email_outbox                    — every email produced (outbox/smtp/zeptomail)
 *  - document_files                  — stored files (s3 key OR inline bytea)
 *  - onboarding_document_templates   — the requestable document library
 *  - onboarding_document_requests    — per-org requested documents + e-sign state
 *
 * `organizations.status` gains no column (it already exists) but now also carries
 * the value `onboarding`. Additive and reversible; the monolith is untouched.
 */
export class OnboardingDocuments1787640000000 implements MigrationInterface {
  name = 'OnboardingDocuments1787640000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // email_outbox
    await queryRunner.query(
      `CREATE TABLE "email_outbox" ("id" character varying(24) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "organization_id" character varying(24), "to" character varying NOT NULL, "subject" character varying NOT NULL, "html" text NOT NULL, "category" character varying, "status" character varying NOT NULL DEFAULT 'queued', "driver" character varying, "error" text, "sent_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_email_outbox_id" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_email_outbox_org" ON "email_outbox" ("organization_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_email_outbox_category" ON "email_outbox" ("category")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_email_outbox_status" ON "email_outbox" ("status")`,
    );

    // document_files
    await queryRunner.query(
      `CREATE TABLE "document_files" ("id" character varying(24) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "organization_id" character varying(24) NOT NULL, "uploaded_by" character varying(24), "original_name" character varying NOT NULL, "mime_type" character varying NOT NULL, "size" integer NOT NULL, "driver" character varying NOT NULL DEFAULT 'db', "storage_key" character varying, "content" bytea, "category" character varying, "is_deleted" boolean NOT NULL DEFAULT false, CONSTRAINT "PK_document_files_id" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_document_file_org" ON "document_files" ("organization_id")`,
    );

    // onboarding_document_templates
    await queryRunner.query(
      `CREATE TABLE "onboarding_document_templates" ("id" character varying(24) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "key" character varying, "name" character varying NOT NULL, "description" text, "category" character varying NOT NULL DEFAULT 'other', "body_html" text, "requires_signature" boolean NOT NULL DEFAULT false, "requires_upload" boolean NOT NULL DEFAULT false, "fields" jsonb, "is_builtin" boolean NOT NULL DEFAULT false, "organization_id" character varying(24), "created_by" character varying(24), "is_deleted" boolean NOT NULL DEFAULT false, CONSTRAINT "PK_onboarding_templates_id" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_onboarding_template_key" ON "onboarding_document_templates" ("key") WHERE "key" IS NOT NULL`,
    );

    // onboarding_document_requests
    await queryRunner.query(
      `CREATE TABLE "onboarding_document_requests" ("id" character varying(24) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "organization_id" character varying(24) NOT NULL, "template_id" character varying(24), "title" character varying NOT NULL, "description" text, "category" character varying NOT NULL DEFAULT 'other', "body_html" text, "requires_signature" boolean NOT NULL DEFAULT false, "requires_upload" boolean NOT NULL DEFAULT false, "fields" jsonb, "status" character varying NOT NULL DEFAULT 'requested', "signature" jsonb, "submitted_file_id" character varying(24), "approval" jsonb, "requested_by" character varying(24), "shared_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "submitted_at" TIMESTAMP WITH TIME ZONE, "last_reminder_at" TIMESTAMP WITH TIME ZONE, "reminder_count" integer NOT NULL DEFAULT 0, "is_deleted" boolean NOT NULL DEFAULT false, CONSTRAINT "PK_onboarding_requests_id" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_onboarding_request_org" ON "onboarding_document_requests" ("organization_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_onboarding_request_status" ON "onboarding_document_requests" ("status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_onboarding_request_status"`);
    await queryRunner.query(`DROP INDEX "public"."idx_onboarding_request_org"`);
    await queryRunner.query(`DROP TABLE "onboarding_document_requests"`);
    await queryRunner.query(`DROP INDEX "public"."uq_onboarding_template_key"`);
    await queryRunner.query(`DROP TABLE "onboarding_document_templates"`);
    await queryRunner.query(`DROP INDEX "public"."idx_document_file_org"`);
    await queryRunner.query(`DROP TABLE "document_files"`);
    await queryRunner.query(`DROP INDEX "public"."idx_email_outbox_status"`);
    await queryRunner.query(`DROP INDEX "public"."idx_email_outbox_category"`);
    await queryRunner.query(`DROP INDEX "public"."idx_email_outbox_org"`);
    await queryRunner.query(`DROP TABLE "email_outbox"`);
  }
}
