import { ExecutionContext, ForbiddenException } from '@nestjs/common';

import { OrgAdminGuard } from './org-admin.guard';

/**
 * Pure unit specs — NO database, no app boot. Exercises OrgAdminGuard's decision
 * logic directly against a stubbed ExecutionContext / req.user. Runs under
 * `npm test`.
 */
describe('OrgAdminGuard (unit)', () => {
  const guard = new OrgAdminGuard();

  const ctxFor = (user: any): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as unknown as ExecutionContext;

  it('lets an org owner through', () => {
    expect(
      guard.canActivate(ctxFor({ orgRole: 'owner', organizationId: 'org-1' })),
    ).toBe(true);
  });

  it('lets an org admin through', () => {
    expect(
      guard.canActivate(ctxFor({ orgRole: 'admin', organizationId: 'org-1' })),
    ).toBe(true);
  });

  it('lets a platform admin through even without an org context', () => {
    expect(
      guard.canActivate(
        ctxFor({ isPlatformAdmin: true, organizationId: null, orgRole: null }),
      ),
    ).toBe(true);
  });

  it('rejects an employee-tier member with 403', () => {
    expect(() =>
      guard.canActivate(
        ctxFor({ orgRole: 'employee', organizationId: 'org-1' }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('rejects a manager-tier member with 403', () => {
    expect(() =>
      guard.canActivate(
        ctxFor({ orgRole: 'manager', organizationId: 'org-1' }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('rejects a session with no org context and no platform-admin flag', () => {
    expect(() =>
      guard.canActivate(ctxFor({ orgRole: 'owner', organizationId: null })),
    ).toThrow(ForbiddenException);
  });

  it('rejects an unauthenticated request (no req.user)', () => {
    expect(() => guard.canActivate(ctxFor(undefined))).toThrow(
      ForbiddenException,
    );
  });
});
