import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/** Where a chunk's bytes came from — a Cloud-Drive file or a raw stored doc. */
export type KnowledgeSourceType = 'drive_file' | 'document_file';

/**
 * One retrievable passage of an org-visible document (Postgres full-text search
 * corpus for the org-QA RAG capability).
 *
 * ISOLATION: every chunk carries the owning `organizationId` and EVERY read
 * (retrieval + status) filters by it, so one tenant's query can never surface
 * another tenant's passage. Only ORG-VISIBLE documents are indexed — Team-Drive
 * files and bridged onboarding/group-chat docs — never a user's private
 * 'My Drive' (personal-scope) file (see KnowledgeIngestionService + PLAYBOOK).
 *
 * FULL-TEXT SEARCH: `search_vector` is a STORED generated tsvector over
 * `content` with a GIN index; retrieval ranks with
 * `ts_rank_cd(search_vector, plainto_tsquery('english', $q))`. It is DB-managed
 * (generated) — never written by the app, so it is mapped read-only here.
 *
 * VECTOR-READY: a pgvector `embedding` column can be added in a future migration
 * beside `search_vector` for hybrid/semantic retrieval — pgvector is NOT enabled
 * now (see PLAYBOOK "vector-upgrade seam").
 */
@Entity('knowledge_chunks')
@Index('ix_knowledge_chunks_org', ['organizationId'])
@Index('uq_knowledge_chunks_org_source_idx', ['organizationId', 'sourceId', 'chunkIndex'], {
  unique: true,
})
export class KnowledgeChunkEntity extends PgBaseEntity {
  /** Owning org — the tenant boundary. Always set from req.user on index. */
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  /** Which store the source lives in: a Cloud-Drive file or a raw document. */
  @Column({ type: 'varchar', default: 'drive_file' })
  sourceType: KnowledgeSourceType;

  /** Id of the source row (drive_files.id or document_files.id) this chunk came from. */
  @Column({ type: 'varchar', length: 24 })
  sourceId: string;

  /** Display name of the source document (for citations). */
  @Column({ type: 'varchar' })
  sourceName: string;

  /** 0-based position of this chunk within its source document. */
  @Column({ type: 'int', default: 0 })
  chunkIndex: number;

  /** The passage text — what is embedded into the FTS vector and shown as context. */
  @Column({ type: 'text' })
  content: string;

  /**
   * STORED generated tsvector over `content`. DB-managed (never inserted/updated
   * by the app); mapped select:false so it never bloats a normal read. Ranked via
   * ts_rank_cd in retrieval; backed by a GIN index (see the migration).
   */
  @Column({
    type: 'tsvector',
    asExpression: "to_tsvector('english', coalesce(content, ''))",
    generatedType: 'STORED',
    nullable: true,
    select: false,
    insert: false,
    update: false,
  })
  searchVector?: unknown;
}
