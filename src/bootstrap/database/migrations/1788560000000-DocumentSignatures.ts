import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two-way client documents, and vendor documents.
 *
 * `client_documents` gains a direction (`origin`/`channel`) so a client can send
 * us a document from their portal, plus the opt-in signature fields for either
 * side. Every flag defaults to false: nothing existing becomes "must be signed".
 *
 * `vendor_documents` is new and one-way — we share, the vendor reads and may be
 * asked to sign; there is no upload from their side.
 */
export class DocumentSignatures1788560000000 implements MigrationInterface {
  name = 'DocumentSignatures1788560000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "client_documents" ADD COLUMN IF NOT EXISTS "origin" character varying NOT NULL DEFAULT 'org'`);
    await queryRunner.query(`ALTER TABLE "client_documents" ADD COLUMN IF NOT EXISTS "channel" character varying`);
    await queryRunner.query(`ALTER TABLE "client_documents" ADD COLUMN IF NOT EXISTS "uploaded_by_name" character varying`);
    await queryRunner.query(`ALTER TABLE "client_documents" ADD COLUMN IF NOT EXISTS "signature_required" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "client_documents" ADD COLUMN IF NOT EXISTS "signature_requested_from_us" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "client_documents" ADD COLUMN IF NOT EXISTS "signature" jsonb`);
    await queryRunner.query(`ALTER TABLE "client_documents" ADD COLUMN IF NOT EXISTS "signed_at" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "client_documents" ADD COLUMN IF NOT EXISTS "signed_file_id" character varying(24)`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "vendor_documents" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "vendor_id" character varying(24) NOT NULL,
        "file_id" character varying(24) NOT NULL,
        "file_name" character varying NOT NULL,
        "mime_type" character varying,
        "size" bigint,
        "title" character varying,
        "description" text,
        "signature_required" boolean NOT NULL DEFAULT false,
        "signature" jsonb,
        "signed_at" TIMESTAMP WITH TIME ZONE,
        "signed_file_id" character varying(24),
        "created_by" character varying(24),
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_vendor_documents" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "ix_vendor_documents_org" ON "vendor_documents" ("organization_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "ix_vendor_documents_vendor" ON "vendor_documents" ("vendor_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "vendor_documents"`);
    for (const col of ['signed_file_id', 'signed_at', 'signature', 'signature_requested_from_us', 'signature_required', 'uploaded_by_name', 'channel', 'origin']) {
      await queryRunner.query(`ALTER TABLE "client_documents" DROP COLUMN IF EXISTS "${col}"`);
    }
  }
}
