import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-user notification preferences (`notification_preferences`). Enforced at
 * delivery time. Additive and reversible.
 */
export class NotificationPreferences1787870000000 implements MigrationInterface {
  name = 'NotificationPreferences1787870000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "notification_preferences" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "user_id" character varying(24) NOT NULL,
        "in_app" boolean NOT NULL DEFAULT true,
        "categories" jsonb NOT NULL DEFAULT '{}',
        "dnd_enabled" boolean NOT NULL DEFAULT false,
        "dnd_allow_urgent" boolean NOT NULL DEFAULT true,
        CONSTRAINT "PK_notification_preferences_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_notif_pref_user" ON "notification_preferences" ("user_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "notification_preferences"`);
  }
}
