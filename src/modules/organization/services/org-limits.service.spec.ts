import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { OrgLimitsService } from './org-limits.service';
import { OrganizationEntity } from '../entities/organization.entity';
import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';
import { DriveQuotaEntity } from '../../storage/entities/drive-quota.entity';
import {
  PlatformSettingsEntity,
  PLATFORM_SETTINGS_ID,
} from '../../admin-platform/entities/platform-settings.entity';
import { DriveService } from '../../storage/drive.service';

const GB = 1024 * 1024 * 1024;

describe('OrgLimitsService (unit, no DB)', () => {
  let service: OrgLimitsService;
  let orgRepo: any;
  let membershipRepo: any;
  let settingsRepo: any;
  let quotaRepo: any;
  let drive: any;

  const settings = (over: any = {}) => ({
    id: PLATFORM_SETTINGS_ID,
    defaultOrgStorageGb: 50,
    defaultUserQuotaGb: 1,
    defaultMaxMembers: null,
    ...over,
  });

  beforeEach(async () => {
    orgRepo = {
      findOne: jest.fn().mockResolvedValue({ id: 'orgA', limits: null }),
      save: jest.fn().mockImplementation(async (x) => x),
    };
    membershipRepo = { count: jest.fn().mockResolvedValue(3) };
    settingsRepo = {
      findOne: jest.fn().mockResolvedValue(settings()),
      create: jest.fn((x) => x),
      save: jest.fn().mockImplementation(async (x) => x),
    };
    quotaRepo = { findOne: jest.fn().mockResolvedValue(null) };
    drive = {
      getQuota: jest.fn().mockResolvedValue({ usedBytes: 0 }),
      setOrgStorageSettings: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        OrgLimitsService,
        { provide: getRepositoryToken(OrganizationEntity), useValue: orgRepo },
        { provide: getRepositoryToken(OrgMembershipEntity), useValue: membershipRepo },
        { provide: getRepositoryToken(PlatformSettingsEntity), useValue: settingsRepo },
        { provide: getRepositoryToken(DriveQuotaEntity), useValue: quotaRepo },
        { provide: DriveService, useValue: drive },
      ],
    }).compile();
    service = moduleRef.get(OrgLimitsService);
  });

  describe('platform defaults', () => {
    it('returns the singleton row', async () => {
      const d = await service.getPlatformDefaults();
      expect(d).toEqual({ defaultOrgStorageGb: 50, defaultUserQuotaGb: 1, defaultMaxMembers: null });
    });

    it('creates the singleton if missing', async () => {
      settingsRepo.findOne.mockResolvedValue(null);
      await service.getPlatformDefaults();
      expect(settingsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: PLATFORM_SETTINGS_ID }),
      );
    });

    it('applies a partial update incl. clearing max members to null (unlimited)', async () => {
      settingsRepo.findOne.mockResolvedValue(settings({ defaultMaxMembers: 25 }));
      const d = await service.setPlatformDefaults(
        { defaultOrgStorageGb: 100, defaultMaxMembers: null },
        'admin1',
      );
      expect(d.defaultOrgStorageGb).toBe(100);
      expect(d.defaultMaxMembers).toBeNull();
      expect(d.defaultUserQuotaGb).toBe(1); // untouched
    });
  });

  describe('getOrgLimits', () => {
    it('falls back to platform defaults when the org has no quota row / override', async () => {
      const view = await service.getOrgLimits('orgA');
      expect(view.storage.teamQuotaGb).toBe(50);
      expect(view.storage.defaultUserQuotaGb).toBe(1);
      expect(view.members).toMatchObject({ count: 3, maxMembers: null, override: null, unlimited: true });
    });

    it('reflects an explicit drive_quota row + a per-org seat override', async () => {
      quotaRepo.findOne.mockResolvedValue({
        limitBytes: String(200 * GB),
        defaultUserLimitBytes: String(5 * GB),
      });
      orgRepo.findOne.mockResolvedValue({ id: 'orgA', limits: { maxMembers: 10 } });
      drive.getQuota.mockResolvedValue({ usedBytes: 100 * GB });
      const view = await service.getOrgLimits('orgA');
      expect(view.storage.teamQuotaGb).toBe(200);
      expect(view.storage.defaultUserQuotaGb).toBe(5);
      expect(view.storage.usedPercent).toBeCloseTo(50, 0);
      expect(view.members).toMatchObject({ maxMembers: 10, override: 10, unlimited: false });
    });

    it('404s an unknown org', async () => {
      orgRepo.findOne.mockResolvedValue(null);
      await expect(service.getOrgLimits('nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('setOrgLimits', () => {
    it('writes storage via DriveService and the seat cap onto the org', async () => {
      await service.setOrgLimits('orgA', { teamQuotaGb: 120, defaultUserQuotaGb: 3, maxMembers: 8 }, 'admin1');
      expect(drive.setOrgStorageSettings).toHaveBeenCalledWith('orgA', {
        quotaGb: 120,
        defaultUserQuotaGb: 3,
      });
      expect(orgRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ limits: expect.objectContaining({ maxMembers: 8 }) }),
      );
    });

    it('does not touch storage when only the seat cap changes', async () => {
      await service.setOrgLimits('orgA', { maxMembers: 5 }, 'admin1');
      expect(drive.setOrgStorageSettings).not.toHaveBeenCalled();
      expect(orgRepo.save).toHaveBeenCalled();
    });

    it('clears the seat override with maxMembers: null', async () => {
      orgRepo.findOne.mockResolvedValue({ id: 'orgA', limits: { maxMembers: 9 } });
      await service.setOrgLimits('orgA', { maxMembers: null }, 'admin1');
      expect(orgRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ limits: { maxMembers: null } }),
      );
    });
  });

  describe('assertSeatAvailable', () => {
    it('is a no-op when unlimited (no override, no platform default)', async () => {
      await expect(service.assertSeatAvailable('orgA')).resolves.toBeUndefined();
    });

    it('allows an add below the cap', async () => {
      orgRepo.findOne.mockResolvedValue({ id: 'orgA', limits: { maxMembers: 5 } });
      membershipRepo.count.mockResolvedValue(4);
      await expect(service.assertSeatAvailable('orgA')).resolves.toBeUndefined();
    });

    it('rejects at/over the cap with SEAT_LIMIT_REACHED', async () => {
      orgRepo.findOne.mockResolvedValue({ id: 'orgA', limits: { maxMembers: 5 } });
      membershipRepo.count.mockResolvedValue(5);
      await expect(service.assertSeatAvailable('orgA')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('uses the platform default cap when the org has no override', async () => {
      settingsRepo.findOne.mockResolvedValue(settings({ defaultMaxMembers: 3 }));
      orgRepo.findOne.mockResolvedValue({ id: 'orgA', limits: null });
      membershipRepo.count.mockResolvedValue(3);
      await expect(service.assertSeatAvailable('orgA')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
