import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Discussion boards (the "communication board") — schema for the legacy
 * `discussionboards` family migration.
 *
 * Four org-scoped tables:
 *   - `discussion_boards` — the board (participants/lanes embedded as jsonb)
 *   - `board_notes`       — sticky notes (canvas geometry + colour)
 *   - `board_nodes`       — flow/diagram shapes
 *   - `board_comments`    — comments on a note
 *
 * Ids are 24-char ObjectId varchars preserved from Mongo `_id` by the ETL, so
 * child `board_id`/`note_id` references keep resolving. (`boardedges` was empty
 * in the source and is not modelled yet.)
 */
export class DiscussionBoards1788170000000 implements MigrationInterface {
  name = 'DiscussionBoards1788170000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── discussion_boards ──
    await queryRunner.query(`
      CREATE TABLE "discussion_boards" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "title" character varying NOT NULL,
        "description" text,
        "template" character varying,
        "background" character varying,
        "created_by" character varying(24),
        "created_by_name" character varying,
        "participants" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "lanes" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "drive_export" jsonb,
        "is_archived" boolean NOT NULL DEFAULT false,
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_discussion_boards" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "ix_discussion_boards_org" ON "discussion_boards" ("organization_id")`);

    // ── board_notes ──
    await queryRunner.query(`
      CREATE TABLE "board_notes" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "board_id" character varying(24) NOT NULL,
        "author_id" character varying(24),
        "author_name" character varying,
        "text" text,
        "title" character varying,
        "color" character varying,
        "x" double precision,
        "y" double precision,
        "width" double precision,
        "height" double precision,
        "z_index" integer,
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_board_notes" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "ix_board_notes_board" ON "board_notes" ("board_id")`);
    await queryRunner.query(`CREATE INDEX "ix_board_notes_org" ON "board_notes" ("organization_id")`);

    // ── board_nodes ──
    await queryRunner.query(`
      CREATE TABLE "board_nodes" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "board_id" character varying(24) NOT NULL,
        "author_id" character varying(24),
        "author_name" character varying,
        "node_kind" character varying,
        "label" text,
        "x" double precision,
        "y" double precision,
        "width" double precision,
        "height" double precision,
        "fill" character varying,
        "stroke" character varying,
        "z_index" integer,
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_board_nodes" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "ix_board_nodes_board" ON "board_nodes" ("board_id")`);
    await queryRunner.query(`CREATE INDEX "ix_board_nodes_org" ON "board_nodes" ("organization_id")`);

    // ── board_comments ──
    await queryRunner.query(`
      CREATE TABLE "board_comments" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "board_id" character varying(24) NOT NULL,
        "note_id" character varying(24),
        "author_id" character varying(24),
        "author_name" character varying,
        "text" text,
        "is_deleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_board_comments" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "ix_board_comments_board" ON "board_comments" ("board_id")`);
    await queryRunner.query(`CREATE INDEX "ix_board_comments_note" ON "board_comments" ("note_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "board_comments"`);
    await queryRunner.query(`DROP TABLE "board_nodes"`);
    await queryRunner.query(`DROP TABLE "board_notes"`);
    await queryRunner.query(`DROP TABLE "discussion_boards"`);
  }
}
