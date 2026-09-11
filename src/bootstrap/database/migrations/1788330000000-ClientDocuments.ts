import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Client document vault — files an org shares with a client (deliverables,
 * reports, etc.), visible for download in the client portal.
 */
export class ClientDocuments1788330000000 implements MigrationInterface {
  name = 'ClientDocuments1788330000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "client_documents" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "client_id" character varying(24) NOT NULL,
        "file_id" character varying(24) NOT NULL,
        "file_name" character varying NOT NULL,
        "mime_type" character varying,
        "size" bigint,
        "title" character varying,
        "description" text,
        "created_by" character varying(24),
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_client_documents" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "ix_client_documents_org" ON "client_documents" ("organization_id")`);
    await queryRunner.query(`CREATE INDEX "ix_client_documents_client" ON "client_documents" ("client_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "client_documents"`);
  }
}
