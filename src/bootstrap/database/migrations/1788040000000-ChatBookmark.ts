import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Chat bookmarks — `chat_bookmarks` (per-user "saved messages"). Additive and
 * reversible; the Mongo monolith is untouched.
 *
 * Notable index choices (mirroring the Mongo schema's intent):
 * - COMPOSITE UNIQUE on `(user_id, message_id)` — a user can bookmark a given
 *   message at most once; makes save idempotent (a repeat is a no-op) and the
 *   Postgres equivalent of the Mongo unique compound index.
 * - Plain index on `user_id` — index-serves the hot "my bookmarks" read.
 */
export class ChatBookmark1788040000000 implements MigrationInterface {
  name = 'ChatBookmark1788040000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "chat_bookmarks" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24),
        "user_id" character varying(24) NOT NULL,
        "message_id" character varying(24) NOT NULL,
        "conversation_id" character varying(24) NOT NULL,
        CONSTRAINT "PK_chat_bookmarks_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_chat_bookmark_user" ON "chat_bookmarks" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "ux_chat_bookmark_user_msg" ON "chat_bookmarks" ("user_id", "message_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "chat_bookmarks"`);
  }
}
