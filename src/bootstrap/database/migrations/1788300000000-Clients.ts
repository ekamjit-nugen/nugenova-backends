import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Clients module — an org's client companies, their contacts (some promoted to
 * portal logins), the staff assigned to serve them, and the discussion boards
 * shared with them.
 */
export class Clients1788300000000 implements MigrationInterface {
  name = 'Clients1788300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "clients" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "company_name" character varying NOT NULL,
        "display_name" character varying,
        "industry" character varying,
        "website" character varying,
        "status" character varying NOT NULL DEFAULT 'active',
        "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "notes" text,
        "primary_contact" jsonb,
        "created_by" character varying(24),
        "updated_by" character varying(24),
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_clients" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "ix_clients_org_status" ON "clients" ("organization_id", "status")`);
    await queryRunner.query(`CREATE INDEX "ix_clients_org_deleted" ON "clients" ("organization_id", "is_deleted")`);

    await queryRunner.query(`
      CREATE TABLE "client_contacts" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "client_id" character varying(24) NOT NULL,
        "name" character varying NOT NULL,
        "email" character varying,
        "phone" character varying,
        "designation" character varying,
        "user_id" character varying(24),
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_client_contacts" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "ix_client_contacts_client" ON "client_contacts" ("client_id")`);
    await queryRunner.query(`CREATE INDEX "ix_client_contacts_org" ON "client_contacts" ("organization_id")`);

    await queryRunner.query(`
      CREATE TABLE "client_assignments" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "client_id" character varying(24) NOT NULL,
        "user_id" character varying(24) NOT NULL,
        "assignment_role" character varying,
        "created_by" character varying(24),
        CONSTRAINT "pk_client_assignments" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_client_assignment" ON "client_assignments" ("client_id", "user_id")`);
    await queryRunner.query(`CREATE INDEX "ix_client_assignments_user" ON "client_assignments" ("organization_id", "user_id")`);

    await queryRunner.query(`
      CREATE TABLE "board_client_shares" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "board_id" character varying(24) NOT NULL,
        "client_id" character varying(24) NOT NULL,
        "permission" character varying NOT NULL DEFAULT 'view',
        "shared_by" character varying(24),
        CONSTRAINT "pk_board_client_shares" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_board_client_share" ON "board_client_shares" ("board_id", "client_id")`);
    await queryRunner.query(`CREATE INDEX "ix_board_client_shares_client" ON "board_client_shares" ("organization_id", "client_id")`);
    await queryRunner.query(`CREATE INDEX "ix_board_client_shares_board" ON "board_client_shares" ("board_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "board_client_shares"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "client_assignments"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "client_contacts"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "clients"`);
  }
}
