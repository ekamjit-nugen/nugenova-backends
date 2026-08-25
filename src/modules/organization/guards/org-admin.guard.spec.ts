import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Repository } from 'typeorm';

import { OrgAdminGuard } from './org-admin.guard';
import { OrganizationEntity } from '../entities/organization.entity';
import { TermsService } from '../../terms/terms.service';
import { RequiredPermission } from './require-permission.decorator';

/**
 * Pure unit specs — NO database, no app boot. Exercises OrgAdminGuard's decision
 * logic: the lifecycle gate (suspended halt, consent for the CURRENT terms
 * version), the owner/admin tier gate for undecorated routes, and the
 * fine-grained permission gate for @RequirePermission routes.
 */
describe('OrgAdminGuard (unit)', () => {
  // Default org: active + consent for v1; current terms v1 → gate is a no-op so
  // tests isolate the role logic. Individual tests override.
  const makeGuard = (
    org: Partial<OrganizationEntity> | null = {
      status: 'active',
      consent: { version: 1 } as any,
    },
    currentVersion = 1,
    required?: RequiredPermission,
  ) => {
    const repo = {
      findOne: jest.fn().mockResolvedValue(org),
    } as unknown as Repository<OrganizationEntity>;
    const terms = {
      needsConsent: jest.fn(
        (_termsId: string | null, consent: { version: number } | null) =>
          !consent || consent.version < currentVersion,
      ),
    } as unknown as TermsService;
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(required),
    } as unknown as Reflector;
    return new OrgAdminGuard(repo, terms, reflector);
  };

  const ctxFor = (user: any): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      getHandler: () => null,
      getClass: () => null,
    }) as unknown as ExecutionContext;

  it('lets an org owner of an active, consented org through', async () => {
    await expect(
      makeGuard().canActivate(
        ctxFor({ orgRole: 'owner', organizationId: 'org-1' }),
      ),
    ).resolves.toBe(true);
  });

  it('lets an org admin of an active, consented org through', async () => {
    await expect(
      makeGuard().canActivate(
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

  it('rejects an owner whose org is suspended (halted) with 403', async () => {
    await expect(
      makeGuard({ status: 'suspended', consent: { version: 1 } as any }).canActivate(
        ctxFor({ orgRole: 'owner', organizationId: 'org-1' }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects an owner whose org has not accepted the terms', async () => {
    await expect(
      makeGuard({ status: 'active', consent: null }).canActivate(
        ctxFor({ orgRole: 'owner', organizationId: 'org-1' }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects an owner whose accepted terms version is stale', async () => {
    await expect(
      makeGuard(
        { status: 'active', consent: { version: 1 } as any },
        2, // current terms is v2, org accepted v1
      ).canActivate(ctxFor({ orgRole: 'owner', organizationId: 'org-1' })),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects an employee-tier member on an undecorated (admin-only) route', async () => {
    await expect(
      makeGuard().canActivate(
        ctxFor({ orgRole: 'employee', organizationId: 'org-1' }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('lets a permScoped member through when their matrix grants the permission', async () => {
    await expect(
      makeGuard(undefined, 1, { resource: 'departments', action: 'view' }).canActivate(
        ctxFor({
          orgRole: 'employee',
          organizationId: 'org-1',
          permScoped: true,
          perms: { departments: ['view'] },
        }),
      ),
    ).resolves.toBe(true);
  });

  it('rejects a permScoped member whose matrix lacks the required permission', async () => {
    await expect(
      makeGuard(undefined, 1, { resource: 'roles', action: 'view' }).canActivate(
        ctxFor({
          orgRole: 'employee',
          organizationId: 'org-1',
          permScoped: true,
          perms: { departments: ['view'] }, // has departments, not roles
        }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('lets an owner through a @RequirePermission route without consulting the matrix', async () => {
    await expect(
      makeGuard(undefined, 1, { resource: 'roles', action: 'delete' }).canActivate(
        ctxFor({ orgRole: 'owner', organizationId: 'org-1' }),
      ),
    ).resolves.toBe(true);
  });

  it('rejects a session with no org context and no platform-admin flag', async () => {
    await expect(
      makeGuard().canActivate(ctxFor({ orgRole: 'owner', organizationId: null })),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects an unauthenticated request (no req.user)', async () => {
    await expect(makeGuard().canActivate(ctxFor(undefined))).rejects.toThrow(
      ForbiddenException,
    );
  });
});
