import { Test } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';

import { AiService } from './ai.service';
import { AiUsageService } from './ai-usage.service';
import { LLM_PROVIDER, LlmCompletion, LlmProvider } from '../providers/llm-provider';
import { AI_POLICY, AiPolicy, AiPolicyDecision } from '../policy/ai-policy';

/**
 * Unit specs for AiService — the metering + policy wrapper over the provider.
 * The provider and policy are STUBS bound to their DI tokens (no network, no DB),
 * and AiUsageService is a mock. Pins: policy gate blocks/allows, the provider is
 * invoked with the messages, every outcome is recorded (success AND error), and
 * a provider failure surfaces a safe generic error while still recording.
 */
describe('AiService', () => {
  let service: AiService;
  let complete: jest.Mock;
  let policyCheck: jest.Mock;
  let record: jest.Mock;

  const stubCompletion: LlmCompletion = {
    text: 'hello world',
    model: 'claude-sonnet-5',
    provider: 'anthropic',
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  };

  const build = async () => {
    complete = jest.fn().mockResolvedValue(stubCompletion);
    policyCheck = jest.fn().mockResolvedValue({ allowed: true } as AiPolicyDecision);
    record = jest.fn().mockResolvedValue(undefined);

    const provider: LlmProvider = {
      name: 'anthropic',
      defaultModel: 'claude-sonnet-5',
      complete,
    };
    const policy: AiPolicy = { check: policyCheck };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AiService,
        { provide: LLM_PROVIDER, useValue: provider },
        { provide: AI_POLICY, useValue: policy },
        { provide: AiUsageService, useValue: { record } },
      ],
    }).compile();
    service = moduleRef.get(AiService);
  };

  beforeEach(build);

  it('runs a completion through the provider and records a success row', async () => {
    const res = await service.complete(
      [{ role: 'user', content: 'hi' }],
      { feature: 'complete' },
      { organizationId: 'orgA', userId: 'u1' },
    );

    expect(res.text).toBe('hello world');
    expect(res.usage.totalTokens).toBe(15);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'success',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        ctx: expect.objectContaining({ organizationId: 'orgA', userId: 'u1', feature: 'complete' }),
      }),
    );
  });

  it('denies the call when the policy blocks it — provider never runs', async () => {
    policyCheck.mockResolvedValue({ allowed: false, reason: 'over tier ceiling', code: 'tier_ceiling' });

    await expect(
      service.complete([{ role: 'user', content: 'hi' }], {}, { organizationId: 'orgA', userId: 'u1' }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(complete).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('records an error row and surfaces a safe message when the provider throws', async () => {
    complete.mockRejectedValue(new Error('boom upstream'));

    await expect(
      service.complete([{ role: 'user', content: 'hi' }], { feature: 'complete' }, { organizationId: 'orgA' }),
    ).rejects.toThrow('AI service is temporarily unavailable. Please try again.');

    expect(record).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
  });

  it('passes model/temperature/maxTokens overrides to the provider', async () => {
    await service.complete(
      [{ role: 'user', content: 'hi' }],
      { model: 'claude-opus-5', temperature: 0.1, maxTokens: 256 },
      { organizationId: 'orgA' },
    );
    expect(complete).toHaveBeenCalledWith(
      [{ role: 'user', content: 'hi' }],
      expect.objectContaining({ model: 'claude-opus-5', temperature: 0.1, maxTokens: 256 }),
    );
  });

  it('summarize() wraps complete() with the text_summarize feature', async () => {
    const out = await service.summarize('long text', { organizationId: 'orgA' }, 20);
    expect(out).toBe('hello world');
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ ctx: expect.objectContaining({ feature: 'text_summarize' }) }));
  });
});
