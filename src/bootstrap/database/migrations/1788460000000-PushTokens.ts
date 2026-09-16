import { MigrationInterface, QueryRunner } from 'typeorm';

/** Browser/device push (FCM) registration tokens per user. */
export class PushTokens1788460000000 implements MigrationInterface {
  name = 'PushTokens1788460000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "push_tokens" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "user_id" character varying(24) NOT NULL,
        "organization_id" character varying(24),
        "token" text NOT NULL,
        "platform" character varying(16) NOT NULL DEFAULT 'web',
        "user_agent" character varying(300),
        "last_seen_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "pk_push_tokens" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS "ux_push_tokens_token" ON "push_tokens" ("token")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "ix_push_tokens_user" ON "push_tokens" ("user_id")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "push_tokens"`);
  }
}
