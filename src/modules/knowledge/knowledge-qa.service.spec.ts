import { Test } from '@nestjs/testing';

import { KnowledgeQaService, ORG_QA_FEATURE } from './knowledge-qa.service';
import { KnowledgeRetrievalService } from './knowledge-retrieval.service';
import { AiService } from '../ai/services/ai.service';

/**
 * Unit specs for the RAG QA orchestrator. Retrieval + AiService are mocked.
 * Pins: /ai/ask retrieves org chunks, assembles a grounded context block, and
 * answers THROUGH AiService.complete with the `org_qa` feature (so policy +
 * metering apply); an unmatched question still answers but flags grounded:false.
 */
describe('KnowledgeQaService', () => {
  let service: KnowledgeQaService;
  const search = jest.fn();
  const complete = jest.fn();

  beforeEach(async () => {
    jest.clearAllMocks();
    complete.mockResolvedValue({
      text: 'You get 20 days [1].',
      provider: 'runpod',
      model: 'qwen',
      usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
    });
    const moduleRef = await Test.createTestingModule({
      providers: [
        KnowledgeQaService,
        { provide: KnowledgeRetrievalService, useValue: { search } },
        { provide: AiService, useValue: { complete } },
      ],
    }).compile();
    service = moduleRef.get(KnowledgeQaService);
  });

  it('retrieves context and answers through AiService.complete with feature org_qa', async () => {
    search.mockResolvedValue([
      { sourceId: 'srcA', sourceName: 'Handbook', chunkIndex: 3, content: 'Employees receive twenty vacation days.', rank: 0.9 },
    ]);

    const res = await service.ask('orgA', 'How many vacation days?', { organizationId: 'orgA', userId: 'u1' }, 4);

    expect(search).toHaveBeenCalledWith('orgA', 'How many vacation days?', 4);
    expect(complete).toHaveBeenCalledTimes(1);

    const [messages, opts, caller] = complete.mock.calls[0];
    // Goes through the gated/metered path with the org_qa feature tag.
    expect(opts.feature).toBe(ORG_QA_FEATURE);
    expect(caller).toEqual({ organizationId: 'orgA', userId: 'u1' });
    // The system message carries the retrieved passage + a numbered source list.
    const system = messages.find((m: any) => m.role === 'system').content;
    expect(system).toContain('Employees receive twenty vacation days.');
    expect(system).toContain('[1] Handbook');
    // The user message is the question.
    expect(messages.find((m: any) => m.role === 'user').content).toBe('How many vacation days?');

    expect(res.grounded).toBe(true);
    expect(res.sources).toEqual([{ sourceId: 'srcA', sourceName: 'Handbook', chunkIndex: 3 }]);
    expect(res.answer).toBe('You get 20 days [1].');
  });

  it('still answers but flags grounded:false when no chunks match', async () => {
    search.mockResolvedValue([]);

    const res = await service.ask('orgA', 'unknown topic', { organizationId: 'orgA', userId: 'u1' });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][1].feature).toBe(ORG_QA_FEATURE);
    expect(res.grounded).toBe(false);
    expect(res.sources).toEqual([]);
  });
});
