import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Repository } from 'typeorm';

import { OrgAdminGuard } from './org-admin.guard';
import { OrganizationEntity } from '../entities/organization.entity';

/**
 * Pure unit specs — NO database, no app boot. Exercises OrgAdminGuard's decision
 * logic directly against a stubbed ExecutionContext / req.user and a stubbed org
 * repo. Runs under `npm test`.
 */
describe('OrgAdminGuard (unit)', () => {
  // Default stub: the org is active, so the status gate is a no-op and the tests
  // isolate the role logic. Individual tests override findOne where needed.
  const makeGuard = (status: string | null = 'active') => {
    const repo = {
      findOne: jest.fn().mockResolvedValue(status ? { status } : null),
    } as unknown as Repository<OrganizationEntity>;
    return new OrgAdminGuard(repo);
  };

  const ctxFor = (user: any): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as unknown as ExecutionContext;

  it('lets an org owner of an active org through', async () => {
    await expect(
      makeGuard('active').canActivate(
        ctxFor({ orgRole: 'owner', organizationId: 'org-1' }),
      ),
    ).resolves.toBe(true);
  });

  it('lets an org admin of an active org through', async () => {
    await expect(
      makeGuard('active').canActivate(
        ctxFor({ orgRole: 'admin', organizationId: 'org-1' }),
      ),
    ).resolves.toBe(true);
  });

  it('lets a platform admin through even without an org context', async () => {
    await expect(
      makeGuard().canActivate(
        ctxFor({ isPlatformAdmin: true, organizationId: null, orgRole: null }),
      ),
    ).resolves.toBe(true);
  });

  it('rejects an org owner whose org is still onboarding with 403', async () => {
    await expect(
      makeGuard('onboarding').canActivate(
        ctxFor({ orgRole: 'owner', organizationId: 'org-1' }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects an employee-tier member with 403', async () => {
    await expect(
      makeGuard('active').canActivate(
        ctxFor({ orgRole: 'employee', organizationId: 'org-1' }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects a manager-tier member with 403', async () => {
    await expect(
      makeGuard('active').canActivate(
        ctxFor({ orgRole: 'manager', organizationId: 'org-1' }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects a session with no org context and no platform-admin flag', async () => {
    await expect(
      makeGuard('active').canActivate(
        ctxFor({ orgRole: 'owner', organizationId: null }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects an unauthenticated request (no req.user)', async () => {
    await expect(
      makeGuard('active').canActivate(ctxFor(undefined)),
    ).rejects.toThrow(ForbiddenException);
  });
});
