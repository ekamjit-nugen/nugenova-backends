import { MigrationInterface, QueryRunner } from 'typeorm';

/** Meetings gain an optional recurring cadence (none | daily | weekly). */
export class MeetingRecurrence1788210000000 implements MigrationInterface {
  name = 'MeetingRecurrence1788210000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "meetings" ADD COLUMN "recurrence" character varying NOT NULL DEFAULT 'none'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "meetings" DROP COLUMN "recurrence"`);
  }
}
