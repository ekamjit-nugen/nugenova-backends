import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { VerticalPackService } from './vertical-pack.service';
import { OrganizationEntity } from '../organization/entities/organization.entity';
import { RoleEntity } from '../auth/entities/role.entity';
import { EDUCATION_ROLE_NAMES } from '../organization/default-roles';
import { DEFAULT_VERTICAL_PACKS } from './vertical-packs';

/**
 * Pure unit specs — NO database. Pin the vertical-pack resolution rules: the
 * company default is unchanged, education packs relabel + enable education
 * modules, an override merges (but can only LOWER the AI ceiling), and switching
 * to an education orgType seeds the education role set idempotently.
 */
describe('VerticalPackService (unit, no DB)', () => {
  let service: VerticalPackService;
  let orgs: any;
  let roles: any;

  const org = (over: Partial<OrganizationEntity> = {}): any => ({
    id: 'org1',
    name: 'Acme',
    orgType: 'company',
    verticalPack: null,
    ...over,
  });

  beforeEach(async () => {
    orgs = {
      findOne: jest.fn(),
      save: jest.fn(async (v) => v),
    };
    roles = {
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((v) => ({ ...v })),
      save: jest.fn(async (v) => v),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        VerticalPackService,
        { provide: getRepositoryToken(OrganizationEntity), useValue: orgs },
        { provide: getRepositoryToken(RoleEntity), useValue: roles },
      ],
    }).compile();
    service = moduleRef.get(VerticalPackService);
  });

  describe('resolvePack', () => {
    it('resolves the company default for a plain org (unchanged)', async () => {
      orgs.findOne.mockResolvedValue(org());
      const pack = await service.resolvePack('org1');
      expect(pack.orgType).toBe('company');
      expect(pack.vocabulary.Member).toBe('Employee');
      expect(pack.aiTierCeiling).toBe(DEFAULT_VERTICAL_PACKS.company.aiTierCeiling);
      expect(pack.hasOverride).toBe(false);
    });

    it('relabels vocabulary + enables education modules for a school', async () => {
      orgs.findOne.mockResolvedValue(org({ orgType: 'school' }));
      const pack = await service.resolvePack('org1');
      expect(pack.vocabulary.Member).toBe('Student');
      expect(pack.vocabulary.Organization).toBe('Institution');
      expect(pack.enabledModules).toContain('lms');
      expect(pack.enabledModules).toContain('guardian');
      // K-12 minors are capped at tier 1 by default.
      expect(pack.aiTierCeiling).toBe(1);
    });

    it('caps coaching at AI tier 3 and college at 2', async () => {
      orgs.findOne.mockResolvedValueOnce(org({ orgType: 'coaching' }));
      expect((await service.resolvePack('org1')).aiTierCeiling).toBe(3);
      orgs.findOne.mockResolvedValueOnce(org({ orgType: 'college' }));
      expect((await service.resolvePack('org1')).aiTierCeiling).toBe(2);
    });

    it('merges a per-org override over the default', async () => {
      orgs.findOne.mockResolvedValue(
        org({ orgType: 'school', verticalPack: { vocabulary: { Member: 'Pupil' } } }),
      );
      const pack = await service.resolvePack('org1');
      expect(pack.vocabulary.Member).toBe('Pupil'); // overridden
      expect(pack.vocabulary.Organization).toBe('Institution'); // from default
      expect(pack.hasOverride).toBe(true);
    });

    it('an override can only LOWER the AI ceiling, never raise it', async () => {
      // A school (default 1) trying to grant itself 3 is clamped to 1.
      orgs.findOne.mockResolvedValue(
        org({ orgType: 'school', verticalPack: { aiTierCeiling: 3 } }),
      );
      expect((await service.resolvePack('org1')).aiTierCeiling).toBe(1);
    });

    it('404s on an unknown org', async () => {
      orgs.findOne.mockResolvedValue(null);
      await expect(service.resolvePack('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('isModuleEnabled / aiTierCeiling', () => {
    it('company does not enable the lms module', async () => {
      orgs.findOne.mockResolvedValue(org());
      expect(await service.isModuleEnabled('org1', 'lms')).toBe(false);
    });
    it('coaching enables the lms module', async () => {
      orgs.findOne.mockResolvedValue(org({ orgType: 'coaching' }));
      expect(await service.isModuleEnabled('org1', 'lms')).toBe(true);
    });
  });

  describe('setPack', () => {
    it('rejects an unknown orgType', async () => {
      orgs.findOne.mockResolvedValue(org());
      await expect(
        service.setPack('org1', { orgType: 'startup' } as any, 'admin'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('switching to school persists the type and seeds education roles', async () => {
      orgs.findOne.mockResolvedValue(org());
      roles.find.mockResolvedValue([]); // none present yet
      const pack = await service.setPack('org1', { orgType: 'school' }, 'admin');
      expect(pack.orgType).toBe('school');
      expect(orgs.save).toHaveBeenCalledWith(
        expect.objectContaining({ orgType: 'school' }),
      );
      // Seeded the education roles.
      const created = roles.save.mock.calls[0][0];
      const names = created.map((r: any) => r.name);
      expect(names).toEqual(
        expect.arrayContaining([...EDUCATION_ROLE_NAMES]),
      );
    });

    it('does NOT seed education roles when staying company', async () => {
      orgs.findOne.mockResolvedValue(org());
      await service.setPack('org1', { verticalPack: null }, 'admin');
      expect(roles.save).not.toHaveBeenCalled();
    });

    it('rejects an out-of-range aiTierCeiling override', async () => {
      orgs.findOne.mockResolvedValue(org({ orgType: 'coaching' }));
      await expect(
        service.setPack('org1', { verticalPack: { aiTierCeiling: 9 } }, 'admin'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('seedEducationRoles', () => {
    it('skips roles that already exist (idempotent)', async () => {
      roles.find.mockResolvedValue([
        { name: 'teacher' },
        { name: 'principal' },
      ]);
      await service.seedEducationRoles('org1', 'admin');
      const created = roles.save.mock.calls[0]?.[0] ?? [];
      const names = created.map((r: any) => r.name);
      expect(names).not.toContain('teacher');
      expect(names).not.toContain('principal');
      expect(names).toContain('registrar');
    });
  });
});
