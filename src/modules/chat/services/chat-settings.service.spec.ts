import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException } from '@nestjs/common';

import { ChatSettingsService, DEFAULT_CHAT_SETTINGS } from './chat-settings.service';
import { OrgChatSettingEntity, OrgChatSettings } from '../entities/org-chat-setting.entity';
import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';

/**
 * Unit specs for ChatSettingsService — the org admin's control over chat for
 * EMPLOYEES. Repos are mocked (no DB). Pins: the defaults merge, the sanitiser's
 * clamps, and that every gate throws for a blocked member but no-ops for an
 * owner/admin (who are never restricted).
 */
describe('ChatSettingsService', () => {
  let service: ChatSettingsService;
  let settingsFindOne: jest.Mock;
  let settingsSave: jest.Mock;
  let membershipFindOne: jest.Mock;

  const withStored = (partial: Partial<OrgChatSettings>) =>
    settingsFindOne.mockResolvedValue({ organizationId: 'orgA', settings: partial });

  beforeEach(async () => {
    settingsFindOne = jest.fn().mockResolvedValue(null);
    settingsSave = jest.fn().mockImplementation(async (r) => r);
    membershipFindOne = jest.fn().mockResolvedValue(null);

    const moduleRef = await Test.createTestingModule({
      providers: [
        ChatSettingsService,
        {
          provide: getRepositoryToken(OrgChatSettingEntity),
          useValue: { findOne: settingsFindOne, save: settingsSave, create: (x: any) => x },
        },
        {
          provide: getRepositoryToken(OrgMembershipEntity),
          useValue: { findOne: membershipFindOne },
        },
      ],
    }).compile();
    service = moduleRef.get(ChatSettingsService);
  });

  describe('load + defaults', () => {
    it('returns the permissive defaults when no row exists', async () => {
      await expect(service.load('orgA')).resolves.toEqual(DEFAULT_CHAT_SETTINGS);
    });

    it('merges the stored partial over the defaults', async () => {
      withStored({ chatEnabled: false, whoCanDm: 'admins' });
      const s = await service.load('orgA');
      expect(s.chatEnabled).toBe(false);
      expect(s.whoCanDm).toBe('admins');
      expect(s.attachmentsEnabled).toBe(true); // untouched default
    });
  });

  describe('update sanitises the payload', () => {
    it('clamps maxFileSizeMb + retentionDays and normalises blocked extensions', async () => {
      const saved = await service.update('orgA', {
        maxFileSizeMb: 9999,
        retentionDays: -5,
        blockedExtensions: ['.EXE', 'bat', 'exe', '  '],
        whoCanDm: 'garbage' as any,
      });
      expect(saved.maxFileSizeMb).toBe(25); // capped at the server hard limit
      expect(saved.retentionDays).toBe(0); // floored at 0
      expect(saved.blockedExtensions).toEqual(['exe', 'bat']); // lowercased, de-dot, de-duped
      expect(saved.whoCanDm).toBe('everyone'); // invalid → default
      expect(settingsSave).toHaveBeenCalled();
    });
  });

  describe('isAdmin', () => {
    it('is true only for owner/admin', () => {
      expect(service.isAdmin('owner')).toBe(true);
      expect(service.isAdmin('admin')).toBe(true);
      expect(service.isAdmin('manager')).toBe(false);
      expect(service.isAdmin(null)).toBe(false);
    });
  });

  describe('gates — members blocked, admins bypass', () => {
    it('assertChatEnabled throws for a member when chat is off, but never for an admin', async () => {
      withStored({ chatEnabled: false });
      await expect(service.assertChatEnabled('orgA', 'manager')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.assertChatEnabled('orgA', 'owner')).resolves.toBeUndefined();
    });

    it('assertCanCreate blocks a member when the policy is admins-only', async () => {
      withStored({ whoCanCreateChannels: 'admins' });
      await expect(service.assertCanCreate('orgA', 'manager', 'channel')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.assertCanCreate('orgA', 'admin', 'channel')).resolves.toBeUndefined();
    });

    it('assertCanDirectMessage (admins) lets a member DM an admin but not another member', async () => {
      withStored({ whoCanDm: 'admins' });
      membershipFindOne.mockResolvedValueOnce({ role: 'admin' }); // target is an admin
      await expect(
        service.assertCanDirectMessage('orgA', 'manager', 'me', 'target'),
      ).resolves.toBeUndefined();

      membershipFindOne.mockResolvedValueOnce({ role: 'member' }); // target is a member
      await expect(
        service.assertCanDirectMessage('orgA', 'manager', 'me', 'target'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('assertCanDirectMessage (same_department) requires a shared department', async () => {
      withStored({ whoCanDm: 'same_department' });
      membershipFindOne
        .mockResolvedValueOnce({ departmentId: 'd1' }) // me
        .mockResolvedValueOnce({ departmentId: 'd1' }); // target
      await expect(
        service.assertCanDirectMessage('orgA', 'manager', 'me', 'target'),
      ).resolves.toBeUndefined();

      membershipFindOne
        .mockResolvedValueOnce({ departmentId: 'd1' })
        .mockResolvedValueOnce({ departmentId: 'd2' });
      await expect(
        service.assertCanDirectMessage('orgA', 'manager', 'me', 'target'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('assertCanBroadcast blocks a member when broadcastAdminsOnly is set', async () => {
      withStored({ broadcastAdminsOnly: true });
      await expect(service.assertCanBroadcast('orgA', 'manager')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.assertCanBroadcast('orgA', 'owner')).resolves.toBeUndefined();
    });

    it('assertCanEditOwn blocks a member when editing is disabled', async () => {
      withStored({ allowEditOwn: false });
      await expect(service.assertCanEditOwn('orgA', 'manager')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.assertCanEditOwn('orgA', 'admin')).resolves.toBeUndefined();
    });

    it('assertAttachmentAllowed enforces enabled + size + blocked type', async () => {
      withStored({ attachmentsEnabled: false });
      await expect(
        service.assertAttachmentAllowed('orgA', 'manager', 'a.png', 10),
      ).rejects.toBeInstanceOf(ForbiddenException);

      withStored({ attachmentsEnabled: true, maxFileSizeMb: 1, blockedExtensions: ['exe'] });
      await expect(
        service.assertAttachmentAllowed('orgA', 'manager', 'big.png', 5 * 1024 * 1024),
      ).rejects.toBeInstanceOf(ForbiddenException); // too big
      await expect(
        service.assertAttachmentAllowed('orgA', 'manager', 'virus.exe', 10),
      ).rejects.toBeInstanceOf(ForbiddenException); // blocked type
      await expect(
        service.assertAttachmentAllowed('orgA', 'manager', 'ok.png', 10),
      ).resolves.toBeUndefined();
      // Admins bypass the attachment policy entirely.
      await expect(
        service.assertAttachmentAllowed('orgA', 'owner', 'virus.exe', 999 * 1024 * 1024),
      ).resolves.toBeUndefined();
    });
  });

  describe('canManageGroup matrix', () => {
    const S = (rule: OrgChatSettings['whoCanManageGroups']): OrgChatSettings => ({
      ...DEFAULT_CHAT_SETTINGS,
      whoCanManageGroups: rule,
    });

    it('org admins always may', () => {
      expect(service.canManageGroup(S('admins'), 'owner', false, undefined)).toBe(true);
    });
    it('creator_and_admins: creator or a group owner/admin, not a plain member', () => {
      expect(service.canManageGroup(S('creator_and_admins'), 'manager', true, 'member')).toBe(true);
      expect(service.canManageGroup(S('creator_and_admins'), 'manager', false, 'admin')).toBe(true);
      expect(service.canManageGroup(S('creator_and_admins'), 'manager', false, 'member')).toBe(false);
    });
    it('any_member: any participant may', () => {
      expect(service.canManageGroup(S('any_member'), 'manager', false, 'member')).toBe(true);
    });
    it('admins: a member never may, even the creator', () => {
      expect(service.canManageGroup(S('admins'), 'manager', true, 'owner')).toBe(false);
    });
    it('a non-participant never may (regardless of policy)', () => {
      expect(service.canManageGroup(S('any_member'), 'manager', false, undefined)).toBe(false);
    });
  });
});
