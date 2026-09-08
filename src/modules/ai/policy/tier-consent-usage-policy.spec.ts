import { ConfigService } from '@nestjs/config';

import { TierConsentUsagePolicy } from './tier-consent-usage-policy';
import { AiPolicyContext } from './ai-policy';

/**
 * Unit specs for the REAL AI policy. Its three dependencies (vertical pack,
 * guardian, usage) are mocked — no DB. Pins the four gates the task requires:
 * allow under ceiling, deny over tier, deny without consent when a subject is
 * set, and deny over the usage cap.
 */
describe('TierConsentUsagePolicy', () => {
  let aiTierCeiling: jest.Mock;
  let isConsented: jest.Mock;
  let getOrgBalance: jest.Mock;
  let policy: TierConsentUsagePolicy;

  const balance = (totalTokens: number, costUsd = 0) => ({
    organizationId: 'orgA',
    period: '2026-09',
    promptTokens: totalTokens,
    completionTokens: 0,
    totalTokens,
    costUsd,
    requestCount: 1,
  });

  const config = (map: Record<string, string> = {}) =>
    ({ get: (k: string) => map[k] }) as unknown as ConfigService;

  const build = (cfg: ConfigService = config()) => {
    aiTierCeiling = jest.fn().mockResolvedValue(3);
    isConsented = jest.fn().mockResolvedValue(true);
    getOrgBalance = jest.fn().mockResolvedValue(balance(0));
    policy = new TierConsentUsagePolicy(
      { aiTierCeiling } as any,
      { isConsented } as any,
      { getOrgBalance } as any,
      cfg,
    );
  };

  const ctx = (over: Partial<AiPolicyContext> = {}): AiPolicyContext => ({
    organizationId: 'orgA',
    userId: 'u1',
    feature: 'complete',
    tier: 1,
    ...over,
  });

  beforeEach(() => build());

  it('allows a call under the tier ceiling, with no subject, under the cap', async () => {
    await expect(policy.check(ctx())).resolves.toEqual({ allowed: true });
    expect(aiTierCeiling).toHaveBeenCalledWith('orgA');
    expect(isConsented).not.toHaveBeenCalled();
  });

  it('denies with tier_ceiling when the requested tier exceeds the ceiling', async () => {
    aiTierCeiling.mockResolvedValue(1);
    const d = await policy.check(ctx({ tier: 3 }));
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('tier_ceiling');
  });

  it('denies with not_consented when a subject is set but has no active consent', async () => {
    isConsented.mockResolvedValue(false);
    const d = await policy.check(ctx({ subjectMembershipId: 'm-student' }));
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('not_consented');
    expect(isConsented).toHaveBeenCalledWith('orgA', 'm-student', 'ai');
  });

  it('allows when a named subject IS consented', async () => {
    isConsented.mockResolvedValue(true);
    await expect(
      policy.check(ctx({ subjectMembershipId: 'm-student' })),
    ).resolves.toEqual({ allowed: true });
  });

  it('denies with usage_ceiling when the org is over its token cap', async () => {
    getOrgBalance.mockResolvedValue(balance(5_000_000));
    const d = await policy.check(ctx());
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('usage_ceiling');
  });

  it('honours a configured cost cap', async () => {
    build(config({ AI_USAGE_COST_CAP_USD: '10' }));
    getOrgBalance.mockResolvedValue(balance(100, 12));
    const d = await policy.check(ctx());
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('usage_ceiling');
  });

  it('allows (no org to scope) when there is no organization context', async () => {
    await expect(
      policy.check(ctx({ organizationId: null })),
    ).resolves.toEqual({ allowed: true });
    expect(aiTierCeiling).not.toHaveBeenCalled();
  });

  it('fails closed on the consent check when the lookup throws', async () => {
    isConsented.mockRejectedValue(new Error('guardian down'));
    const d = await policy.check(ctx({ subjectMembershipId: 'm-student' }));
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('not_consented');
  });
});
