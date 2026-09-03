import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import {
  PERSON_TYPES,
  STAFF_PERSON_TYPE,
  applyStaffScope,
  staffScope,
} from './person-type';
import { OrgMembershipEntity } from './org-membership.entity';
import { UserEntity } from './user.entity';
import { RoleEntity } from './role.entity';
import { MembershipService } from '../../organization/services/membership.service';

/**
 * The education-vertical guard. `staffScope()` narrows any OrgMembership query to
 * `personType = 'staff'`; the last block is a BUILD-FAILING regression guard —
 * it fails the build if a staff-scoped surface (the org directory) ever stops
 * excluding non-staff (student/guardian) memberships.
 */
describe('person-type / staffScope (unit, no DB)', () => {
  describe('constants', () => {
    it("defaults staff to 'staff' and lists the three person types", () => {
      expect(STAFF_PERSON_TYPE).toBe('staff');
      expect([...PERSON_TYPES]).toEqual(['staff', 'student', 'guardian']);
    });
  });

  describe('staffScope()', () => {
    it("injects personType:'staff' into an empty filter", () => {
      expect(staffScope()).toEqual({ personType: 'staff' });
    });

    it('merges without dropping the caller filters', () => {
      expect(staffScope({ organizationId: 'org1', status: 'active' })).toEqual({
        organizationId: 'org1',
        status: 'active',
        personType: 'staff',
      });
    });

    it('always forces staff even if a caller tried to pass another type', () => {
      // personType is appended last, so it can't be overridden to student.
      expect(staffScope({ personType: 'student' } as any).personType).toBe('staff');
    });
  });

  describe('applyStaffScope()', () => {
    it('appends a person_type = staff andWhere onto a query builder', () => {
      const qb: any = { andWhere: jest.fn().mockReturnThis() };
      const out = applyStaffScope(qb, 'm');
      expect(qb.andWhere).toHaveBeenCalledWith('m.personType = :__staffPersonType', {
        __staffPersonType: 'staff',
      });
      expect(out).toBe(qb);
    });
  });

  // ── BUILD-FAILING GUARD ─────────────────────────────────────────────────────
  // The org directory (MembershipService.list) must never enumerate a non-staff
  // membership. We back the repo with a real in-memory filter so a student row is
  // only excluded if the service actually staff-scoped its query. Delete the
  // staffScope from list() and this test goes red.
  describe('guard: the org directory excludes non-staff memberships', () => {
    it('never returns a student/guardian membership', async () => {
      const rows: any[] = [
        { id: 'm1', userId: 'u1', organizationId: 'org1', role: 'employee', personType: 'staff', status: 'active', createdAt: new Date() },
        { id: 'm2', userId: 'u2', organizationId: 'org1', role: 'employee', personType: 'student', status: 'active', createdAt: new Date() },
        { id: 'm3', userId: 'u3', organizationId: 'org1', role: 'employee', personType: 'guardian', status: 'active', createdAt: new Date() },
      ];
      const matches = (row: any, where: any) =>
        Object.entries(where).every(([k, v]) => row[k] === v);
      const membershipRepo: any = {
        find: jest.fn(async ({ where }: any) => rows.filter((r) => matches(r, where))),
      };
      const userRepo: any = { find: jest.fn(async () => []) };
      const roleRepo: any = { find: jest.fn(async () => []) };

      const moduleRef = await Test.createTestingModule({
        providers: [
          MembershipService,
          { provide: getRepositoryToken(OrgMembershipEntity), useValue: membershipRepo },
          { provide: getRepositoryToken(UserEntity), useValue: userRepo },
          { provide: getRepositoryToken(RoleEntity), useValue: roleRepo },
        ],
      }).compile();
      const service = moduleRef.get(MembershipService);

      const listed = await service.list('org1');
      const ids = listed.map((m: any) => m.membershipId);
      expect(ids).toContain('m1');
      expect(ids).not.toContain('m2'); // student
      expect(ids).not.toContain('m3'); // guardian
      // And the query itself was staff-scoped (defence in depth).
      expect(membershipRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ personType: 'staff' }) }),
      );
    });
  });
});
