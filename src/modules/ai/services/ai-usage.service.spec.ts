import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AiUsageService, promptFromMessages } from './ai-usage.service';
import { AiUsageEventEntity } from '../entities/ai-usage-event.entity';
import { AiUsageCounterEntity } from '../entities/ai-usage-counter.entity';

/**
 * Unit specs for AiUsageService — the credit-metering ledger. Repos are mocked
 * (no DB). Pins: record() writes an event + increments the counter with an
 * estimated cost, skips calls with no org, never throws, and getOrgBalance
 * returns zeros when no row exists.
 */
describe('AiUsageService', () => {
  let service: AiUsageService;
  let eventCreate: jest.Mock;
  let eventSave: jest.Mock;
  let counterQuery: jest.Mock;
  let counterFindOne: jest.Mock;
  let counterFind: jest.Mock;

  beforeEach(async () => {
    eventCreate = jest.fn().mockImplementation((x) => x);
    eventSave = jest.fn().mockResolvedValue(undefined);
    counterQuery = jest.fn().mockResolvedValue(undefined);
    counterFindOne = jest.fn().mockResolvedValue(null);
    counterFind = jest.fn().mockResolvedValue([]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        AiUsageService,
        {
          provide: getRepositoryToken(AiUsageEventEntity),
          useValue: { create: eventCreate, save: eventSave },
        },
        {
          provide: getRepositoryToken(AiUsageCounterEntity),
          useValue: {
            findOne: counterFindOne,
            find: counterFind,
            manager: { query: counterQuery },
          },
        },
      ],
    }).compile();
    service = moduleRef.get(AiUsageService);
  });

  it('periodOf formats YYYY-MM in UTC', () => {
    expect(service.periodOf(new Date(Date.UTC(2026, 8, 3)))).toBe('2026-09');
  });

  it('promptFromMessages keeps role labels', () => {
    expect(promptFromMessages([{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }])).toBe(
      'system: S\n\nuser: U',
    );
  });

  it('records an event and increments the counter with an estimated cost', async () => {
    await service.record({
      ctx: { organizationId: 'orgA', userId: 'u1', feature: 'complete' },
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      usage: { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 },
      status: 'success',
    });

    // claude-sonnet-5: $2/1M in + $10/1M out → $12 for 1M+1M.
    expect(eventSave).toHaveBeenCalledWith(expect.objectContaining({ costUsd: 12, totalTokens: 2_000_000 }));
    expect(counterQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = counterQuery.mock.calls[0];
    expect(sql).toContain('ON CONFLICT');
    expect(params).toEqual(
      expect.arrayContaining(['orgA', expect.stringMatching(/^\d{4}-\d{2}$/), 1_000_000, 1_000_000, 2_000_000, 12]),
    );
  });

  it('skips recording when there is no organizationId', async () => {
    await service.record({ ctx: { organizationId: null, feature: 'complete' }, provider: 'anthropic', model: 'x' });
    expect(eventSave).not.toHaveBeenCalled();
    expect(counterQuery).not.toHaveBeenCalled();
  });

  it('never throws even if the DB write fails', async () => {
    eventSave.mockRejectedValue(new Error('db down'));
    await expect(
      service.record({ ctx: { organizationId: 'orgA', feature: 'complete' }, provider: 'anthropic', model: 'x' }),
    ).resolves.toBeUndefined();
  });

  it('getOrgBalance returns zeros when the org has no counter row', async () => {
    const bal = await service.getOrgBalance('orgA', '2026-09');
    expect(bal).toEqual({
      organizationId: 'orgA',
      period: '2026-09',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      requestCount: 0,
    });
  });

  it('getOrgBalance coerces bigint/numeric strings to numbers', async () => {
    counterFindOne.mockResolvedValue({
      promptTokens: '100',
      completionTokens: '50',
      totalTokens: '150',
      costUsd: '0.001500',
      requestCount: 3,
    });
    const bal = await service.getOrgBalance('orgA', '2026-09');
    expect(bal.totalTokens).toBe(150);
    expect(bal.costUsd).toBeCloseTo(0.0015, 6);
    expect(bal.requestCount).toBe(3);
  });
});
