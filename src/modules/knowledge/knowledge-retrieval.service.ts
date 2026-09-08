import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { KnowledgeChunkEntity } from './entities/knowledge-chunk.entity';

/** One retrieved passage with its FTS relevance rank. */
export interface RetrievedChunk {
  sourceId: string;
  sourceName: string;
  chunkIndex: number;
  content: string;
  rank: number;
}

export const DEFAULT_TOP_K = 6;
const MAX_TOP_K = 20;
const MIN_QUERY_CHARS = 2;

/**
 * Org-scoped full-text retrieval over `knowledge_chunks`.
 *
 * ISOLATION: `organization_id = $1` is ALWAYS the first bound parameter of the
 * ranked query, so a search can only ever match the caller's own org — a chunk
 * belonging to another tenant is unreachable. Ranking uses
 * `ts_rank_cd(search_vector, plainto_tsquery('english', $2))` against the GIN
 * index; an empty/too-short query short-circuits to `[]` (no query = no leak).
 */
@Injectable()
export class KnowledgeRetrievalService {
  constructor(
    @InjectRepository(KnowledgeChunkEntity)
    private readonly chunks: Repository<KnowledgeChunkEntity>,
  ) {}

  /**
   * Return the top-K org-scoped chunks ranked by FTS relevance to `query`.
   * Empty/whitespace/too-short queries return `[]`.
   */
  async search(organizationId: string, query: string, topK = DEFAULT_TOP_K): Promise<RetrievedChunk[]> {
    const q = (query || '').trim();
    if (!organizationId || q.length < MIN_QUERY_CHARS) return [];
    const limit = Math.min(Math.max(1, Math.floor(topK) || DEFAULT_TOP_K), MAX_TOP_K);

    // organization_id is the FIRST bound param — the tenant boundary is enforced
    // inside the SQL, never post-filtered in app code.
    const rows = await this.chunks.query(
      `
      SELECT
        source_id   AS "sourceId",
        source_name AS "sourceName",
        chunk_index AS "chunkIndex",
        content     AS "content",
        ts_rank_cd(search_vector, plainto_tsquery('english', $2)) AS "rank"
      FROM knowledge_chunks
      WHERE organization_id = $1
        AND search_vector @@ plainto_tsquery('english', $2)
      ORDER BY "rank" DESC, chunk_index ASC
      LIMIT $3
      `,
      [organizationId, q, limit],
    );

    return (rows as Array<Record<string, unknown>>).map((r) => ({
      sourceId: String(r.sourceId),
      sourceName: String(r.sourceName),
      chunkIndex: Number(r.chunkIndex),
      content: String(r.content),
      rank: Number(r.rank),
    }));
  }
}
