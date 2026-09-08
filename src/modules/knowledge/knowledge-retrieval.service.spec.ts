import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { KnowledgeRetrievalService } from './knowledge-retrieval.service';
import { KnowledgeChunkEntity } from './entities/knowledge-chunk.entity';

/**
 * Unit specs for org-scoped FTS retrieval.
 *
 * The repository's raw `query()` is faked with an in-memory dataset that
 * ENFORCES the org filter exactly as the SQL does: it returns only rows whose
 * `organization_id` equals the first bound parameter ($1). The headline test
 * proves cross-org isolation — orgA's search never returns orgB's chunk even
 * though the other org's chunk textually matches the query.
 */
describe('KnowledgeRetrievalService', () => {
  type Row = { organization_id: string; source_id: string; source_name: string; chunk_index: number; content: string };

  const dataset: Row[] = [
    { organization_id: 'orgA', source_id: 'srcA', source_name: 'Handbook A', chunk_index: 0, content: 'the vacation policy allows twenty days off' },
    { organization_id: 'orgB', source_id: 'srcB', source_name: 'Handbook B', chunk_index: 0, content: 'the vacation policy allows thirty days off' },
  ];

  // Faithful-enough fake of the ranked SQL: filter by org ($1), match any query
  // token against the content ($2), honour the LIMIT ($3).
  const query = jest.fn(async (_sql: string, params: any[]) => {
    const [orgId, q, limit] = params;
    const tokens = String(q).toLowerCase().split(/\s+/).filter(Boolean);
    return dataset
      .filter((r) => r.organization_id === orgId)
      .filter((r) => tokens.some((t) => r.content.toLowerCase().includes(t)))
      .slice(0, limit)
      .map((r) => ({
        sourceId: r.source_id,
        sourceName: r.source_name,
        chunkIndex: r.chunk_index,
        content: r.content,
        rank: 0.5,
      }));
  });

  let service: KnowledgeRetrievalService;

  beforeEach(async () => {
    query.mockClear();
    const moduleRef = await Test.createTestingModule({
      providers: [
        KnowledgeRetrievalService,
        { provide: getRepositoryToken(KnowledgeChunkEntity), useValue: { query } },
      ],
    }).compile();
    service = moduleRef.get(KnowledgeRetrievalService);
  });

  it('is org-scoped: a query never returns another org\'s chunk', async () => {
    const aResults = await service.search('orgA', 'vacation policy');
    expect(aResults).toHaveLength(1);
    expect(aResults[0].sourceId).toBe('srcA');
    // orgB's "vacation policy" chunk must be unreachable from orgA.
    expect(aResults.every((r) => r.sourceId !== 'srcB')).toBe(true);

    const bResults = await service.search('orgB', 'vacation policy');
    expect(bResults).toHaveLength(1);
    expect(bResults[0].sourceId).toBe('srcB');

    // The org id is ALWAYS the first bound parameter of the ranked query.
    expect(query).toHaveBeenLastCalledWith(expect.any(String), ['orgB', 'vacation policy', expect.any(Number)]);
  });

  it('returns [] for empty/too-short queries without hitting the DB', async () => {
    expect(await service.search('orgA', '')).toEqual([]);
    expect(await service.search('orgA', ' ')).toEqual([]);
    expect(await service.search('orgA', 'a')).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns [] when there is no org context', async () => {
    expect(await service.search('', 'vacation policy')).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('clamps topK into the allowed range', async () => {
    await service.search('orgA', 'vacation', 999);
    expect(query.mock.calls[0][1][2]).toBe(20); // MAX_TOP_K
    query.mockClear();
    await service.search('orgA', 'vacation', 0);
    expect(query.mock.calls[0][1][2]).toBe(6); // falls back to DEFAULT_TOP_K
  });
});
