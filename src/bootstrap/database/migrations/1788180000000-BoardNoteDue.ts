import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Discussion-board notes gain a due date + completion, powering deadline
 * reminders (a day before, on the day, and when overdue) that stop once the note
 * is marked complete. `reminders_sent` records which stages have already fired so
 * the daily/ hourly sweep never double-notifies.
 */
export class BoardNoteDue1788180000000 implements MigrationInterface {
  name = 'BoardNoteDue1788180000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "board_notes" ADD COLUMN "due_date" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "board_notes" ADD COLUMN "completed" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "board_notes" ADD COLUMN "completed_at" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "board_notes" ADD COLUMN "reminders_sent" jsonb NOT NULL DEFAULT '[]'::jsonb`);
    // The reminder sweep scans open, dated notes.
    await queryRunner.query(`CREATE INDEX "ix_board_notes_due" ON "board_notes" ("due_date") WHERE "due_date" IS NOT NULL AND "completed" = false AND "is_deleted" = false`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."ix_board_notes_due"`);
    await queryRunner.query(`ALTER TABLE "board_notes" DROP COLUMN "reminders_sent"`);
    await queryRunner.query(`ALTER TABLE "board_notes" DROP COLUMN "completed_at"`);
    await queryRunner.query(`ALTER TABLE "board_notes" DROP COLUMN "completed"`);
    await queryRunner.query(`ALTER TABLE "board_notes" DROP COLUMN "due_date"`);
  }
}
