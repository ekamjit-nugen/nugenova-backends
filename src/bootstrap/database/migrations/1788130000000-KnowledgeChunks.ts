import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Org-level document-retrieval (RAG) corpus — Postgres full-text search.
 *
 * `knowledge_chunks` holds one row per retrievable passage of an ORG-VISIBLE
 * document (Team-Drive files + bridged onboarding/group-chat docs; NEVER a
 * private 'My Drive' file). Everything is `organization_id`-scoped so retrieval
 * can never cross a tenant boundary.
 *
 * Full-text search: `search_vector` is a STORED generated `tsvector` over
 * `content` (`to_tsvector('english', …)`) with a GIN index; retrieval ranks with
 * `ts_rank_cd(search_vector, plainto_tsquery('english', $q))`. A plain btree on
 * `organization_id` scopes every read, and a UNIQUE `(organization_id,
 * source_id, chunk_index)` makes re-indexing a source idempotent (delete old
 * rows, insert fresh ones).
 *
 * VECTOR-READY: a future migration can add a pgvector `embedding` column beside
 * `search_vector` for semantic/hybrid retrieval. pgvector is intentionally NOT
 * enabled here (no `CREATE EXTENSION vector`) — this build ships FTS only.
 */
export class KnowledgeChunks1788130000000 implements MigrationInterface {
  name = 'KnowledgeChunks1788130000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "knowledge_chunks" (
        "id" character varying(24) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" character varying(24) NOT NULL,
        "source_type" character varying NOT NULL DEFAULT 'drive_file',
        "source_id" character varying(24) NOT NULL,
        "source_name" character varying NOT NULL,
        "chunk_index" integer NOT NULL DEFAULT 0,
        "content" text NOT NULL,
        "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce("content", ''))) STORED,
        CONSTRAINT "PK_knowledge_chunks" PRIMARY KEY ("id")
      )
    `);

    // Ranked lookup: GIN over the generated tsvector (the FTS index).
    await queryRunner.query(
      `CREATE INDEX "ix_knowledge_chunks_search_vector" ON "knowledge_chunks" USING GIN ("search_vector")`,
    );
    // Tenant scoping — every retrieval/status read filters by org.
    await queryRunner.query(
      `CREATE INDEX "ix_knowledge_chunks_org" ON "knowledge_chunks" ("organization_id")`,
    );
    // Idempotent re-index: one row per (org, source, chunk position).
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_knowledge_chunks_org_source_idx" ON "knowledge_chunks" ("organization_id", "source_id", "chunk_index")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."uq_knowledge_chunks_org_source_idx"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."ix_knowledge_chunks_org"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."ix_knowledge_chunks_search_vector"`);
    await queryRunner.query(`DROP TABLE "knowledge_chunks"`);
  }
}
