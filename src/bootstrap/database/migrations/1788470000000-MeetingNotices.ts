import { MigrationInterface, QueryRunner } from 'typeorm';

/** Per-user record that a meeting's join prompt was joined/dismissed. */
export class MeetingNotices1788470000000 implements MigrationInterface {
  name = 'MeetingNotices1788470000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "meeting_notices" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "meeting_id" character varying(24) NOT NULL,
        "user_id" character varying(24) NOT NULL,
        "action" character varying(16) NOT NULL DEFAULT 'dismissed',
        CONSTRAINT "pk_meeting_notices" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS "ux_meeting_notice" ON "meeting_notices" ("meeting_id", "user_id")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "ix_meeting_notice_user" ON "meeting_notices" ("user_id")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "meeting_notices"`);
  }
}
