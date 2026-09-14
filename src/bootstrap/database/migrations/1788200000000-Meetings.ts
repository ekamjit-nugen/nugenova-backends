import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Video meetings (Jitsi-powered). Our app owns scheduling, invites, access and
 * lifecycle; the A/V room is a Jitsi room keyed by the unique `room_name`.
 */
export class Meetings1788200000000 implements MigrationInterface {
  name = 'Meetings1788200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "meetings" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "title" character varying NOT NULL,
        "description" text,
        "host_id" character varying(24) NOT NULL,
        "host_name" character varying,
        "room_name" character varying NOT NULL,
        "scheduled_start" TIMESTAMP WITH TIME ZONE,
        "scheduled_end" TIMESTAMP WITH TIME ZONE,
        "status" character varying NOT NULL DEFAULT 'scheduled',
        "is_instant" boolean NOT NULL DEFAULT false,
        "participants" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "lobby_enabled" boolean NOT NULL DEFAULT true,
        "passcode" character varying,
        "started_at" TIMESTAMP WITH TIME ZONE,
        "ended_at" TIMESTAMP WITH TIME ZONE,
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "pk_meetings" PRIMARY KEY ("id"),
        CONSTRAINT "uq_meetings_room" UNIQUE ("room_name")
      )
    `);
    await queryRunner.query(`CREATE INDEX "ix_meetings_org" ON "meetings" ("organization_id")`);
    await queryRunner.query(`CREATE INDEX "ix_meetings_host" ON "meetings" ("host_id")`);
    await queryRunner.query(`CREATE INDEX "ix_meetings_start" ON "meetings" ("scheduled_start")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."ix_meetings_start"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."ix_meetings_host"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."ix_meetings_org"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "meetings"`);
  }
}
