import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Notifications — the per-recipient in-app inbox (`notifications` table). One row
 * per user per event; every read/write is scoped by `user_id` so notifications
 * are isolated to their recipient. Additive and reversible; the Mongo monolith
 * is untouched.
 */
export class Notifications1787860000000 implements MigrationInterface {
  name = 'Notifications1787860000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "notifications" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "user_id" character varying(24) NOT NULL,
        "actor_id" character varying(24),
        "type" character varying NOT NULL,
        "category" character varying NOT NULL DEFAULT 'system',
        "title" character varying NOT NULL,
        "body" text,
        "data" jsonb NOT NULL DEFAULT '{}',
        "priority" character varying NOT NULL DEFAULT 'normal',
        "read" boolean NOT NULL DEFAULT false,
        "read_at" TIMESTAMP WITH TIME ZONE,
        "group_key" character varying,
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_notifications_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_notif_user_created" ON "notifications" ("user_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_notif_user_read" ON "notifications" ("user_id", "read", "is_deleted")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_notif_org_user" ON "notifications" ("organization_id", "user_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "notifications"`);
  }
}
