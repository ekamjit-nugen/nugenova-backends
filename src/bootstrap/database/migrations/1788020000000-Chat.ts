import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Chat / messaging — `chat_conversations` (DMs, groups, channels, self) +
 * `chat_messages`. Ported from the Mongo chat-service. Additive and reversible;
 * the Mongo monolith is untouched.
 *
 * Notable index choices (mirroring the Mongo schema's intent):
 * - GIN on `chat_conversations.participant_ids` — index-serves the hot
 *   "conversations I'm a participant of" filter (`:me = ANY(participant_ids)`),
 *   the Postgres equivalent of the Mongo `participants.userId` index.
 * - PARTIAL UNIQUE on `chat_messages.idempotency_key` (WHERE key IS NOT NULL) —
 *   the Postgres equivalent of Mongo's sparse-unique index; makes the
 *   double-send de-dupe race-safe.
 */
export class Chat1788020000000 implements MigrationInterface {
  name = 'Chat1788020000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "chat_conversations" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24),
        "type" character varying NOT NULL DEFAULT 'direct',
        "channel_type" character varying,
        "name" character varying,
        "description" text,
        "avatar" text,
        "icon" character varying,
        "topic" character varying,
        "category_id" character varying(24),
        "client_id" character varying(24),
        "participants" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "participant_ids" text[] NOT NULL DEFAULT '{}'::text[],
        "last_message" jsonb,
        "message_count" integer NOT NULL DEFAULT 0,
        "settings" jsonb,
        "meeting_id" character varying(24),
        "is_archived" boolean NOT NULL DEFAULT false,
        "created_by" character varying(24) NOT NULL,
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_chat_conversations_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_chat_conv_org" ON "chat_conversations" ("organization_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_chat_conv_participant_ids" ON "chat_conversations" USING GIN ("participant_ids")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_chat_conv_org_channeltype" ON "chat_conversations" ("organization_id", "channel_type")`,
    );

    await queryRunner.query(`
      CREATE TABLE "chat_messages" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "conversation_id" character varying(24) NOT NULL,
        "organization_id" character varying(24),
        "thread_id" character varying(24),
        "sender_id" character varying(24) NOT NULL,
        "sender_name" character varying,
        "content" text NOT NULL DEFAULT '',
        "content_plain_text" text,
        "type" character varying NOT NULL DEFAULT 'text',
        "reply_to" character varying(24),
        "idempotency_key" character varying,
        "status" character varying NOT NULL DEFAULT 'sent',
        "file_url" character varying,
        "file_name" character varying,
        "file_size" integer,
        "file_mime_type" character varying,
        "file_id" character varying(24),
        "delivered_to" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "attachments" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "mentions" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "reactions" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "read_by" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "edit_history" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "forwarded_from" jsonb,
        "is_edited" boolean NOT NULL DEFAULT false,
        "edited_at" TIMESTAMP WITH TIME ZONE,
        "is_deleted" boolean NOT NULL DEFAULT false,
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        "deleted_by" character varying(24),
        "is_pinned" boolean NOT NULL DEFAULT false,
        "pinned_by" character varying(24),
        "pinned_at" TIMESTAMP WITH TIME ZONE,
        "priority" character varying NOT NULL DEFAULT 'normal',
        CONSTRAINT "PK_chat_messages_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_chat_msg_conv_created" ON "chat_messages" ("conversation_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_chat_msg_conv_deleted" ON "chat_messages" ("conversation_id", "is_deleted")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_chat_msg_sender" ON "chat_messages" ("sender_id")`,
    );
    // Sparse-unique equivalent: only rows with a key participate in uniqueness.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "ux_chat_msg_idempotency" ON "chat_messages" ("idempotency_key") WHERE "idempotency_key" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "chat_messages"`);
    await queryRunner.query(`DROP TABLE "chat_conversations"`);
  }
}
