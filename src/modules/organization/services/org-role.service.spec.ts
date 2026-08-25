import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';

import { OrgRoleService } from './org-role.service';
import { RoleEntity } from '../../auth/entities/role.entity';
import { DEFAULT_ROLES } from '../default-roles';

/** Pure unit specs — NO database. Covers custom-role CRUD + default seeding. */
describe('OrgRoleService (unit, no DB)', () => {
  let service: OrgRoleService;
  let repo: any;

  beforeEach(async () => {
    repo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      create: jest.fn((v) => ({ ...v })),
      save: jest.fn(async (v) => (Array.isArray(v) ? v : { id: v.id ?? 'role-1', ...v })),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        OrgRoleService,
        { provide: getRepositoryToken(RoleEntity), useValue: repo },
      ],
    }).compile();
    service = moduleRef.get(OrgRoleService);
  });

  describe('create', () => {
    it('creates a role scoped to the org with its permission matrix', async () => {
      repo.findOne.mockResolvedValue(null); // no name clash
      await service.create(
        'org-1',
        { name: 'Auditor', permissions: [{ resource: 'reports', actions: ['view'] }] } as any,
        'creator',
      );
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: 'org-1',
          name: 'Auditor',
          permissions: [{ resource: 'reports', actions: ['view'] }],
          createdBy: 'creator',
        }),
      );
    });

    it('rejects a duplicate role name within the org', async () => {
      repo.findOne.mockResolvedValue({ id: 'x', name: 'Auditor' });
      await expect(
        service.create('org-1', { name: 'Auditor' } as any, 'creator'),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('seedDefaults', () => {
    it('creates the default roles when none exist (idempotent shape)', async () => {
      repo.find.mockResolvedValueOnce([]); // none present yet
      repo.find.mockResolvedValueOnce(DEFAULT_ROLES.map((r, i) => ({ id: `r${i}`, ...r }))); // list() after
      await service.seedDefaults('org-1', 'creator');
      const created = repo.save.mock.calls[0][0];
      expect(Array.isArray(created)).toBe(true);
      expect(created.map((r: any) => r.name).sort()).toEqual(
        DEFAULT_ROLES.map((r) => r.name).sort(),
      );
    });

    it('skips roles that already exist (no duplicates)', async () => {
      // HR already present → only developer + designer get created.
      repo.find.mockResolvedValueOnce([{ id: 'hrx', name: 'hr' }]);
      repo.find.mockResolvedValueOnce([]);
      await service.seedDefaults('org-1', 'creator');
      const created = repo.save.mock.calls[0][0];
      const names = created.map((r: any) => r.name);
      expect(names).not.toContain('hr');
      expect(names).toContain('developer');
      expect(names).toContain('designer');
    });

    it('does nothing when every default already exists', async () => {
      repo.find.mockResolvedValueOnce(DEFAULT_ROLES.map((r) => ({ id: r.name, name: r.name })));
      repo.find.mockResolvedValueOnce([]);
      await service.seedDefaults('org-1', 'creator');
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  describe('get / update / remove', () => {
    it('404s on a missing role', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.get('org-1', 'nope')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('soft-deletes (isDeleted) rather than hard-deleting', async () => {
      const role = { id: 'r1', organizationId: 'org-1', isDeleted: false };
      repo.findOne.mockResolvedValue(role);
      await service.remove('org-1', 'r1');
      expect(role.isDeleted).toBe(true);
      expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ isDeleted: true }));
    });
  });
});
