import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

import { AuthService } from './auth.service';
import { UserEntity } from './entities/user.entity';
import { OrgMembershipEntity } from './entities/org-membership.entity';
import { SessionEntity } from './entities/session.entity';
import { RoleEntity } from './entities/role.entity';
import { AuditService } from './services/audit.service';
import { TokenRevocationService } from './services/token-revocation.service';

/**
 * Pure unit specs — NO database. All repositories and collaborators are jest
 * mocks, so these run under `npm test` (jest.config.js) against nothing but the
 * in-memory service. Covers the deterministic decision logic:
 *   - determinePostLoginRoute (routing rules incl. the pending-invite @bug)
 *   - parseExpiryToSeconds (JWT expiry parsing)
 *   - validateJwtPayload (guard payload sanity check)
 */
describe('AuthService (unit, no DB)', () => {
  let service: AuthService;
  let membershipRepo: { find: jest.Mock };

  const asUser = (u: Partial<UserEntity>): UserEntity =>
    ({ id: 'u1', ...u }) as UserEntity;

  beforeEach(async () => {
    membershipRepo = { find: jest.fn().mockResolvedValue([]) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(UserEntity), useValue: {} },
        { provide: getRepositoryToken(OrgMembershipEntity), useValue: membershipRepo },
        { provide: getRepositoryToken(SessionEntity), useValue: {} },
        { provide: getRepositoryToken(RoleEntity), useValue: {} },
        { provide: JwtService, useValue: { sign: jest.fn(), verify: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
        {
          provide: TokenRevocationService,
          useValue: { revoke: jest.fn(), isRevoked: jest.fn() },
        },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
  });

  describe('determinePostLoginRoute', () => {
    it('routes a platform admin to /platform before touching memberships', async () => {
      const route = await service.determinePostLoginRoute(
        asUser({ isPlatformAdmin: true }),
      );
      expect(route).toEqual({ route: '/platform', reason: 'platform_admin' });
      expect(membershipRepo.find).not.toHaveBeenCalled();
    });

    it('routes an all-client member to the client portal', async () => {
      membershipRepo.find.mockResolvedValue([
        { role: 'client', status: 'active', organizationId: 'orgC' },
      ]);
      const route = await service.determinePostLoginRoute(
        asUser({ setupStage: 'complete' }),
      );
      expect(route).toMatchObject({
        route: '/portal',
        reason: 'client_portal',
        organizationId: 'orgC',
      });
    });

    it('routes an all-vendor member to the vendor portal', async () => {
      membershipRepo.find.mockResolvedValue([
        { role: 'vendor', status: 'active', organizationId: 'orgV' },
      ]);
      const route = await service.determinePostLoginRoute(
        asUser({ setupStage: 'complete' }),
      );
      expect(route).toMatchObject({
        route: '/vendor-portal',
        reason: 'vendor_portal',
        organizationId: 'orgV',
      });
    });

    it('routes a brand-new user with no memberships to org setup', async () => {
      membershipRepo.find.mockResolvedValue([]);
      const route = await service.determinePostLoginRoute(
        asUser({ setupStage: 'otp_verified' }),
      );
      expect(route).toEqual({
        route: '/auth/setup-organization',
        reason: 'new_user',
      });
    });

    it('routes a completed single-org user to the dashboard', async () => {
      membershipRepo.find.mockResolvedValue([
        { role: 'manager', status: 'active', organizationId: 'org1' },
      ]);
      const route = await service.determinePostLoginRoute(
        asUser({ setupStage: 'complete' }),
      );
      expect(route).toEqual({
        route: '/dashboard',
        reason: 'active_user',
        organizationId: 'org1',
      });
    });

    it('routes a completed multi-active-org user to select-organization', async () => {
      membershipRepo.find.mockResolvedValue([
        { role: 'manager', status: 'active', organizationId: 'orgA' },
        { role: 'employee', status: 'active', organizationId: 'orgB' },
      ]);
      const route = await service.determinePostLoginRoute(
        asUser({ setupStage: 'complete' }),
      );
      expect(route).toMatchObject({
        route: '/auth/select-organization',
        reason: 'multi_org',
        organizations: ['orgA', 'orgB'],
      });
    });

    it('@bug: a pending/invited membership wins over an active one', async () => {
      membershipRepo.find.mockResolvedValue([
        { role: 'manager', status: 'active', organizationId: 'orgActive' },
        { role: 'employee', status: 'pending', organizationId: 'orgPending' },
      ]);
      const route = await service.determinePostLoginRoute(
        asUser({ setupStage: 'complete' }),
      );
      expect(route).toEqual({
        route: '/auth/accept-invite',
        reason: 'pending_invite',
        organizationId: 'orgPending',
      });
    });

    it('routes org_created setup stage to profile setup', async () => {
      membershipRepo.find.mockResolvedValue([]);
      const route = await service.determinePostLoginRoute(
        asUser({ setupStage: 'org_created' }),
      );
      expect(route).toEqual({
        route: '/auth/setup-profile',
        reason: 'incomplete_profile',
      });
    });

    it('routes a completed user whose orgs were all removed back to setup', async () => {
      membershipRepo.find.mockResolvedValue([]);
      const route = await service.determinePostLoginRoute(
        asUser({ setupStage: 'complete' }),
      );
      expect(route).toEqual({
        route: '/auth/setup-organization',
        reason: 'no_active_org',
      });
    });
  });

  describe('parseExpiryToSeconds', () => {
    const parse = (v: string): number =>
      (service as any).parseExpiryToSeconds(v);

    it('parses minutes', () => expect(parse('15m')).toBe(900));
    it('parses seconds', () => expect(parse('30s')).toBe(30));
    it('parses hours', () => expect(parse('2h')).toBe(7200));
    it('parses days', () => expect(parse('1d')).toBe(86400));
    it('falls back to 900 on an unparseable value', () =>
      expect(parse('nonsense')).toBe(900));
  });

  describe('validateJwtPayload', () => {
    it('accepts a payload with sub and email', () => {
      expect(service.validateJwtPayload({ sub: 'u1', email: 'a@b.c' })).toBe(true);
    });
    it('rejects a payload missing sub', () => {
      expect(service.validateJwtPayload({ email: 'a@b.c' })).toBe(false);
    });
    it('rejects a payload missing email', () => {
      expect(service.validateJwtPayload({ sub: 'u1' })).toBe(false);
    });
    it('rejects null/undefined', () => {
      expect(service.validateJwtPayload(null)).toBe(false);
      expect(service.validateJwtPayload(undefined)).toBe(false);
    });
  });
});
