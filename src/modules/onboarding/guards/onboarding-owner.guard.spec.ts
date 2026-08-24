import { ExecutionContext, ForbiddenException } from '@nestjs/common';

import { OnboardingOwnerGuard } from './onboarding-owner.guard';

/**
 * Pure unit specs — no DB, no app boot. The onboarding surface is reachable by an
 * owner/admin scoped to an org REGARDLESS of the org's status (that's the point —
 * it's where an onboarding org submits documents).
 */
describe('OnboardingOwnerGuard (unit)', () => {
  const guard = new OnboardingOwnerGuard();
  const ctxFor = (user: any): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as unknown as ExecutionContext;

  it('lets an owner with an org context through', () => {
    expect(
      guard.canActivate(ctxFor({ orgRole: 'owner', organizationId: 'org-1' })),
    ).toBe(true);
  });

  it('lets an admin with an org context through', () => {
    expect(
      guard.canActivate(ctxFor({ orgRole: 'admin', organizationId: 'org-1' })),
    ).toBe(true);
  });

  it('rejects an employee-tier member', () => {
    expect(() =>
      guard.canActivate(
        ctxFor({ orgRole: 'employee', organizationId: 'org-1' }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('rejects a session with no org context', () => {
    expect(() =>
      guard.canActivate(ctxFor({ orgRole: 'owner', organizationId: null })),
    ).toThrow(ForbiddenException);
  });

  it('rejects an unauthenticated request', () => {
    expect(() => guard.canActivate(ctxFor(undefined))).toThrow(
      ForbiddenException,
    );
  });
});
