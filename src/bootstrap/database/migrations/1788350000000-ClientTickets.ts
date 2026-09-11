import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Client support tickets — requests a client raises from the portal (or an org
 * opens for them), with a two-way message thread.
 */
export class ClientTickets1788350000000 implements MigrationInterface {
  name = 'ClientTickets1788350000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "client_tickets" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "client_id" character varying(24) NOT NULL,
        "subject" character varying NOT NULL,
        "description" text,
        "category" character varying NOT NULL DEFAULT 'request',
        "status" character varying NOT NULL DEFAULT 'open',
        "priority" character varying NOT NULL DEFAULT 'normal',
        "created_by" character varying(24),
        "created_by_name" character varying,
        "created_by_role" character varying NOT NULL DEFAULT 'client',
        "assigned_to_user_id" character varying(24),
        "last_message_at" TIMESTAMP WITH TIME ZONE,
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_client_tickets" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "ix_client_tickets_org" ON "client_tickets" ("organization_id")`);
    await queryRunner.query(`CREATE INDEX "ix_client_tickets_client" ON "client_tickets" ("client_id")`);

    await queryRunner.query(`
      CREATE TABLE "client_ticket_messages" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "ticket_id" character varying(24) NOT NULL,
        "author_id" character varying(24),
        "author_name" character varying,
        "author_role" character varying NOT NULL DEFAULT 'client',
        "body" text NOT NULL,
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_client_ticket_messages" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "ix_client_ticket_messages_ticket" ON "client_ticket_messages" ("ticket_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "client_ticket_messages"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "client_tickets"`);
  }
}
