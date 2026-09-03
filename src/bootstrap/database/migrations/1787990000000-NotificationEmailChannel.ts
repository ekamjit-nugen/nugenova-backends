import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Notification preferences gain an EMAIL channel alongside in-app: a master
 * `email` switch and per-category `email_categories` toggles (same shape as the
 * existing in-app `categories`). Defaults keep every channel ON so existing
 * accounts start receiving notification emails without any action.
 */
export class NotificationEmailChannel1787990000000 implements MigrationInterface {
  name = 'NotificationEmailChannel1787990000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "notification_preferences" ADD "email" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification_preferences" ADD "email_categories" jsonb NOT NULL DEFAULT '{}'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "notification_preferences" DROP COLUMN "email_categories"`);
    await queryRunner.query(`ALTER TABLE "notification_preferences" DROP COLUMN "email"`);
  }
}
