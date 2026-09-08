import { AllowAllAiPolicy } from './ai-policy';

/**
 * The default policy is the documented no-op seam: it allows every call until
 * feat/lms-p0's aiTierCeiling + guardian consent merge and a real policy is
 * bound to AI_POLICY. This pins that default so a future real policy can't be
 * swapped in silently without updating the test.
 */
describe('AllowAllAiPolicy', () => {
  it('allows every call', async () => {
    const policy = new AllowAllAiPolicy();
    await expect(
      policy.check({ organizationId: 'orgA', userId: 'u1', feature: 'complete' }),
    ).resolves.toEqual({ allowed: true });
  });

  it('allows even when there is no org/user context', async () => {
    const policy = new AllowAllAiPolicy();
    await expect(
      policy.check({ organizationId: null, userId: null, feature: 'other' }),
    ).resolves.toEqual({ allowed: true });
  });
});
