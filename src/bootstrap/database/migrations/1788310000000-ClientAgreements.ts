import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Client agreements — documents (rich text and/or an attached PDF) an org sends
 * to a client for e-signature. The client reads and signs them in the portal;
 * the drawn/typed signature + audit trail is stored on the row.
 */
export class ClientAgreements1788310000000 implements MigrationInterface {
  name = 'ClientAgreements1788310000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "client_agreements" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "client_id" character varying(24) NOT NULL,
        "title" character varying NOT NULL,
        "description" text,
        "category" character varying NOT NULL DEFAULT 'other',
        "body_html" text,
        "source_file_id" character varying(24),
        "status" character varying NOT NULL DEFAULT 'draft',
        "signature" jsonb,
        "sent_at" TIMESTAMP WITH TIME ZONE,
        "signed_at" TIMESTAMP WITH TIME ZONE,
        "created_by" character varying(24),
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_client_agreements" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "ix_client_agreements_org" ON "client_agreements" ("organization_id")`);
    await queryRunner.query(`CREATE INDEX "ix_client_agreements_client" ON "client_agreements" ("client_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "client_agreements"`);
  }
}
