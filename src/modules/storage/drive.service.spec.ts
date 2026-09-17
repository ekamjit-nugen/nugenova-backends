import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

import {
  DriveService,
  DEFAULT_TEAM_QUOTA_GB,
  DEFAULT_USER_QUOTA_GB,
} from './drive.service';
import { DriveFolderEntity } from './entities/drive-folder.entity';
import { DriveFileEntity } from './entities/drive-file.entity';
import { DriveShareEntity } from './entities/drive-share.entity';
import { DriveQuotaEntity } from './entities/drive-quota.entity';
import { DriveGrantEntity } from './entities/drive-grant.entity';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { DocumentFileEntity } from '../../bootstrap/storage/document-file.entity';
import { ConversationEntity } from '../chat/entities/conversation.entity';
import { MessageEntity } from '../chat/entities/message.entity';
import { StorageService } from '../../bootstrap/storage/storage.service';
import { NotifierService } from '../notification/notifier.service';
import { NoopOfficeConvertProvider, OFFICE_CONVERT_PROVIDER } from './office-convert.provider';

const GB = 1024 * 1024 * 1024;

/**
 * Unit specs for DriveService — repos + the shared StorageService are mocked (no
 * DB, no S3). Pins the load-bearing rules: quota defaults + enforcement, the
 * access grant, byte delegation to StorageService on upload, folder-name
 * validation, and share password gating.
 */
describe('DriveService', () => {
  let service: DriveService;
  let folderRepo: any;
  let fileRepo: any;
  let shareRepo: any;
  let quotaRepo: any;
  let grantRepo: any;
  let membershipRepo: any;
  let userRepo: any;
  let documentFileRepo: any;
  let conversationRepo: any;
  let messageRepo: any;
  let storage: { save: jest.Mock; getMeta: jest.Mock; openStream: jest.Mock; getBytes: jest.Mock };
  let notifier: { notify: jest.Mock };

  // A minimal query-builder stub whose SUM/COUNT resolves to the configured totals.
  const makeQb = (raw: any) => {
    const qb: any = {};
    for (const m of ['select', 'addSelect', 'where', 'andWhere', 'groupBy', 'update', 'set', 'whereInIds', 'orderBy']) {
      qb[m] = jest.fn().mockReturnValue(qb);
    }
    qb.getRawOne = jest.fn().mockResolvedValue(raw);
    qb.getRawMany = jest.fn().mockResolvedValue([]);
    qb.getMany = jest.fn().mockResolvedValue([]);
    qb.execute = jest.fn().mockResolvedValue({ affected: 0 });
    return qb;
  };

  beforeEach(async () => {
    folderRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((x) => x),
      save: jest.fn().mockImplementation(async (x) => ({ id: 'folder1', ...x })),
      createQueryBuilder: jest.fn().mockReturnValue(makeQb({ bytes: '0', count: '0' })),
    };
    fileRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
      create: jest.fn().mockImplementation((x) => x),
      save: jest.fn().mockImplementation(async (x) => ({ id: 'file1', ...x })),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn().mockReturnValue(makeQb({ bytes: '0', count: '0' })),
    };
    shareRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((x) => x),
      save: jest.fn().mockImplementation(async (x) => ({ id: 'share1', ...x })),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn().mockReturnValue(makeQb({})),
    };
    quotaRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((x) => x),
      save: jest.fn().mockImplementation(async (x) => x),
    };
    grantRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((x) => x),
      save: jest.fn().mockImplementation(async (x) => ({ id: 'grant1', ...x })),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn().mockReturnValue(makeQb({})),
    };
    membershipRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockImplementation(async (x) => x),
    };
    userRepo = { find: jest.fn().mockResolvedValue([]) };
    documentFileRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    conversationRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    messageRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    storage = {
      save: jest.fn().mockResolvedValue({ id: 'doc1', originalName: 'a.txt', mimeType: 'text/plain', size: 10, createdAt: new Date() }),
      getMeta: jest.fn().mockResolvedValue({ id: 'doc1' }),
      openStream: jest.fn().mockResolvedValue({ stream: {} as any, mimeType: 'text/plain', filename: 'a.txt', size: 10 }),
      getBytes: jest.fn().mockResolvedValue(Buffer.from('hi')),
    };
    notifier = { notify: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        DriveService,
        { provide: getRepositoryToken(DriveFolderEntity), useValue: folderRepo },
        { provide: getRepositoryToken(DriveFileEntity), useValue: fileRepo },
        { provide: getRepositoryToken(DriveShareEntity), useValue: shareRepo },
        { provide: getRepositoryToken(DriveQuotaEntity), useValue: quotaRepo },
        { provide: getRepositoryToken(DriveGrantEntity), useValue: grantRepo },
        { provide: getRepositoryToken(OrgMembershipEntity), useValue: membershipRepo },
        { provide: getRepositoryToken(UserEntity), useValue: userRepo },
        { provide: getRepositoryToken(DocumentFileEntity), useValue: documentFileRepo },
        { provide: getRepositoryToken(ConversationEntity), useValue: conversationRepo },
        { provide: getRepositoryToken(MessageEntity), useValue: messageRepo },
        { provide: StorageService, useValue: storage },
        { provide: NotifierService, useValue: notifier },
        { provide: OFFICE_CONVERT_PROVIDER, useClass: NoopOfficeConvertProvider },
      ],
    }).compile();

    service = moduleRef.get(DriveService);
  });

  describe('quota', () => {
    it('applies the default team quota when no row exists', async () => {
      const q = await service.getQuota('orgA');
      expect(q.quotaGb).toBe(DEFAULT_TEAM_QUOTA_GB);
      expect(q.usedBytes).toBe(0);
      expect(q.usedPercent).toBe(0);
    });

    it('applies the default user quota when no override/row exists', async () => {
      const q = await service.getUserQuota('orgA', 'userA');
      expect(q.quotaGb).toBe(DEFAULT_USER_QUOTA_GB);
    });

    it('honours a per-user quota override on the membership', async () => {
      membershipRepo.findOne.mockResolvedValue({ cloudDrive: { quotaGb: 5 } });
      const q = await service.getUserQuota('orgA', 'userA');
      expect(q.quotaGb).toBe(5);
      expect(q.quotaBytes).toBe(5 * GB);
    });
  });

  describe('access', () => {
    it('lets owners/admins/platform-admins through without a grant', async () => {
      expect(await service.canUseCloudDrive('orgA', 'u', 'admin')).toBe(true);
      expect(await service.canUseCloudDrive('orgA', 'u', 'owner')).toBe(true);
      expect(await service.canUseCloudDrive('orgA', 'u', 'employee', true)).toBe(true);
    });

    it('requires an explicit grant for plain members', async () => {
      membershipRepo.findOne.mockResolvedValue({ cloudDrive: { enabled: false } });
      expect(await service.canUseCloudDrive('orgA', 'u', 'employee')).toBe(false);
      await expect(service.assertCanUseCloudDrive('orgA', 'u', 'employee')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('grants access and notifies the member', async () => {
      membershipRepo.findOne.mockResolvedValue({ organizationId: 'orgA', userId: 'u', cloudDrive: {} });
      await service.setUserAccess('orgA', 'u', true, 'admin1');
      expect(membershipRepo.save).toHaveBeenCalled();
      expect(notifier.notify).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u', type: 'storage_access_granted' }),
      );
    });
  });

  describe('bridge (chat routing + onboarding)', () => {
    const doc = (over: any = {}) => ({
      id: 'doc9',
      organizationId: 'orgA',
      originalName: 'secret.png',
      mimeType: 'image/png',
      size: 1234,
      uploadedBy: 'u1',
      category: 'chat',
      isDeleted: false,
      ...over,
    });

    it('routes a DM attachment into EACH participant’s My Drive (personal scope)', async () => {
      conversationRepo.findOne.mockResolvedValue({
        id: 'c1',
        organizationId: 'orgA',
        type: 'direct',
        participantIds: ['uA', 'uB'],
      });
      documentFileRepo.findOne.mockResolvedValue(doc({ category: 'chat' }));

      await service.bridgeChatMessage({
        organizationId: 'orgA',
        conversationId: 'c1',
        fileIds: ['doc9'],
      });

      // One personal-scope drive file per participant, each in their own folder.
      const savedScopes = fileRepo.save.mock.calls.map(([x]: any[]) => ({
        scope: x.scope,
        ownerId: x.ownerId,
      }));
      expect(savedScopes).toEqual([
        { scope: 'personal', ownerId: 'uA' },
        { scope: 'personal', ownerId: 'uB' },
      ]);
      expect(folderRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Shared in Chat', scope: 'personal', ownerId: 'uA' }),
      );
    });

    it('routes a group/channel attachment into Team Drive (team scope)', async () => {
      conversationRepo.findOne.mockResolvedValue({
        id: 'c2',
        organizationId: 'orgA',
        type: 'group',
        participantIds: ['uA', 'uB', 'uC'],
      });
      documentFileRepo.findOne.mockResolvedValue(doc({ category: 'chat' }));

      await service.bridgeChatMessage({
        organizationId: 'orgA',
        conversationId: 'c2',
        fileIds: ['doc9'],
      });

      expect(fileRepo.save).toHaveBeenCalledTimes(1);
      expect(fileRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'team', ownerId: null }),
      );
    });

    it('reconciles: a DM file previously mirrored to Team Drive gets that stale row pruned', async () => {
      conversationRepo.findOne.mockResolvedValue({
        id: 'c1',
        organizationId: 'orgA',
        type: 'direct',
        participantIds: ['uA', 'uB'],
      });
      documentFileRepo.findOne.mockResolvedValue(doc({ category: 'chat' }));
      let n = 0;
      fileRepo.save.mockImplementation(async (x: any) => ({ id: `k${++n}`, ...x }));
      // After the two personal rows are created, the file has a stale team row too.
      fileRepo.find.mockResolvedValue([
        { id: 'team_old', storageFileId: 'doc9' },
        { id: 'k1', storageFileId: 'doc9' },
        { id: 'k2', storageFileId: 'doc9' },
      ]);
      const qb = fileRepo.createQueryBuilder();

      await service.bridgeChatMessage({
        organizationId: 'orgA',
        conversationId: 'c1',
        fileIds: ['doc9'],
      });

      // Only the wrongly-scoped team mirror is soft-deleted; the personal rows stay.
      expect(qb.whereInIds).toHaveBeenCalledWith(['team_old']);
    });

    it('bridgeDocumentFile indexes onboarding to Team Drive, and skips chat/drive/cross-org', async () => {
      documentFileRepo.findOne.mockResolvedValue(doc({ category: 'onboarding' }));
      const row = await service.bridgeDocumentFile('doc9', { organizationId: 'orgA' });
      expect(row).toMatchObject({ scope: 'team', ownerId: null });
      expect(folderRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Onboarding' }),
      );

      documentFileRepo.findOne.mockResolvedValue(doc({ category: 'chat' }));
      expect(await service.bridgeDocumentFile('doc9')).toBeNull(); // chat → message path
      documentFileRepo.findOne.mockResolvedValue(doc({ category: 'drive' }));
      expect(await service.bridgeDocumentFile('doc9')).toBeNull();
      documentFileRepo.findOne.mockResolvedValue(doc({ organizationId: 'orgB' }));
      expect(await service.bridgeDocumentFile('doc9', { organizationId: 'orgA' })).toBeNull();
    });

    it('is idempotent — an existing row for the same (file, scope, owner) is reused', async () => {
      documentFileRepo.findOne.mockResolvedValue(doc({ category: 'onboarding' }));
      fileRepo.findOne.mockResolvedValue({ id: 'existing', storageFileId: 'doc9' });
      const row = await service.bridgeDocumentFile('doc9');
      expect(row).toMatchObject({ id: 'existing' });
      expect(fileRepo.save).not.toHaveBeenCalled();
    });

    it('backfill is message-driven: DM→My Drive, group→Team, and reports counts', async () => {
      messageRepo.find.mockResolvedValue([
        { conversationId: 'c1', fileId: 'd1', attachments: [] },
        { conversationId: 'c2', fileId: 'd2', attachments: [] },
      ]);
      conversationRepo.findOne.mockImplementation(async ({ where }: any) =>
        where.id === 'c1'
          ? { id: 'c1', organizationId: 'orgA', type: 'direct', participantIds: ['uA', 'uB'] }
          : { id: 'c2', organizationId: 'orgA', type: 'group', participantIds: ['uA', 'uB', 'uC'] },
      );
      documentFileRepo.findOne.mockImplementation(async ({ where }: any) =>
        doc({ id: where.id, category: 'chat' }),
      );
      documentFileRepo.find.mockResolvedValue([]); // no non-chat docs

      const res = await service.backfillFromStorage('orgA');
      expect(res.scanned).toBe(2);
      expect(res.linked).toBe(3); // d1 → 2 personal, d2 → 1 team
      expect(res.pruned).toBe(0);
    });
  });

  describe('folders', () => {
    it('rejects a folder name containing a slash', async () => {
      await expect(
        service.createFolder({ organizationId: 'orgA', userId: 'u', name: 'a/b', scope: 'team' }),
      ).rejects.toBeInstanceOf(Error);
    });

    it('creates a team folder at the root with a materialized path', async () => {
      const f = await service.createFolder({ organizationId: 'orgA', userId: 'u', name: 'Docs', scope: 'team' });
      expect(f.path).toBe('/Docs');
      expect(f.ownerId).toBeNull();
      expect(folderRepo.save).toHaveBeenCalled();
    });
  });

  describe('upload', () => {
    it('delegates bytes to StorageService and stores a metadata row', async () => {
      const f = await service.uploadFile({
        organizationId: 'orgA',
        userId: 'u',
        name: 'a.txt',
        scope: 'team',
        contentType: 'text/plain',
        body: Buffer.from('hello'),
      });
      expect(storage.save).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: 'orgA', category: 'drive' }),
      );
      expect(f.storageFileId).toBe('doc1');
      expect(f.size).toBe(10);
    });

    it('rejects an empty upload', async () => {
      await expect(
        service.uploadFile({ organizationId: 'orgA', userId: 'u', name: 'a', scope: 'team', body: Buffer.alloc(0) }),
      ).rejects.toBeInstanceOf(Error);
    });

    it('enforces the team quota before writing bytes', async () => {
      // Team quota row = 1 byte; the upload of 5 bytes must be rejected.
      quotaRepo.findOne.mockResolvedValue({ limitBytes: '1', defaultUserLimitBytes: null });
      await expect(
        service.uploadFile({ organizationId: 'orgA', userId: 'u', name: 'a.txt', scope: 'team', body: Buffer.from('hello') }),
      ).rejects.toMatchObject({ response: { code: 'STORAGE_QUOTA_EXCEEDED' } });
      expect(storage.save).not.toHaveBeenCalled();
    });
  });

  describe('shares', () => {
    it('gates a password-protected share on the correct password', async () => {
      // Create a share with a password, then verify open() enforces it.
      fileRepo.findOne.mockResolvedValue({ id: 'file1', organizationId: 'orgA', scope: 'team', ownerId: null });
      const { token } = await service.createShare({
        organizationId: 'orgA',
        userId: 'u',
        targetType: 'file',
        targetId: 'file1',
        scope: 'team',
        password: 's3cret',
      });
      const savedShare = shareRepo.save.mock.results[0].value as any;
      const resolved = await savedShare;
      shareRepo.findOne.mockResolvedValue({ ...resolved, revoked: false, expiresAt: null, accessCount: 0, save: undefined });

      await expect(service.openShare(token, 'wrong')).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.openShare(token, 's3cret')).resolves.toBeDefined();
    });

    it('404s an unknown or revoked share token', async () => {
      shareRepo.findOne.mockResolvedValue(null);
      await expect(service.getShareInfo('nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('preview', () => {
    it('refuses a non-PDF preview when no converter is configured', async () => {
      fileRepo.findOne.mockResolvedValue({ id: 'file1', organizationId: 'orgA', name: 'deck.pptx', mimeType: 'application/vnd', storageFileId: 'doc1' });
      await expect(service.getPreviewPdf('orgA', 'file1')).rejects.toBeInstanceOf(Error);
    });

    it('passes a PDF straight through', async () => {
      fileRepo.findOne.mockResolvedValue({ id: 'file1', organizationId: 'orgA', name: 'report.pdf', mimeType: 'application/pdf', storageFileId: 'doc1' });
      const res = await service.getPreviewPdf('orgA', 'file1');
      expect(res.name).toBe('report.pdf');
      expect(storage.openStream).toHaveBeenCalled();
    });
  });

  describe('internal grants (share with org members)', () => {
    it('grants access to a member on a file the actor owns', async () => {
      fileRepo.findOne.mockResolvedValue({ id: 'f1', organizationId: 'orgA', scope: 'personal', ownerId: 'owner1', name: 'doc.pdf' });
      membershipRepo.findOne.mockResolvedValue({ userId: 'bob' }); // bob is a member
      grantRepo.findOne.mockResolvedValue(null); // no existing grant
      const res = await service.grantAccess({
        organizationId: 'orgA', actorId: 'owner1', actorName: 'Owner',
        targetType: 'file', targetId: 'f1', granteeUserIds: ['bob', 'owner1'], permission: 'edit',
      });
      expect(res.granted).toBe(1); // self (owner1) is skipped
      expect(grantRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ granteeUserId: 'bob', permission: 'edit', scope: 'personal' }),
      );
    });

    it('refuses to share a personal file the actor does not own', async () => {
      fileRepo.findOne.mockResolvedValue({ id: 'f1', organizationId: 'orgA', scope: 'personal', ownerId: 'someone-else' });
      await expect(
        service.grantAccess({
          organizationId: 'orgA', actorId: 'intruder', targetType: 'file', targetId: 'f1',
          granteeUserIds: ['bob'], permission: 'view',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lets an edit-grantee rename, but blocks a view-grantee', async () => {
      // Non-owner file; grantee holds an edit grant → rename allowed.
      fileRepo.findOne.mockResolvedValue({ id: 'f1', organizationId: 'orgA', scope: 'personal', ownerId: 'owner1', name: 'old' });
      grantRepo.findOne.mockResolvedValue({ permission: 'edit', granteeUserId: 'bob' });
      const renamed = await service.renameFile('orgA', 'f1', 'personal', 'bob', 'new');
      expect(renamed.name).toBe('new');

      // Same file, only a view grant → rename forbidden.
      grantRepo.findOne.mockResolvedValue({ permission: 'view', granteeUserId: 'bob' });
      await expect(service.renameFile('orgA', 'f1', 'personal', 'bob', 'x')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lists items shared with me with permission + sharer', async () => {
      grantRepo.find.mockResolvedValue([
        { id: 'g1', targetType: 'file', targetId: 'f1', permission: 'download', grantedByName: 'Alice' },
        { id: 'g2', targetType: 'folder', targetId: 'fo1', permission: 'edit', grantedByName: 'Alice' },
      ]);
      fileRepo.findOne.mockResolvedValue({ id: 'f1', name: 'shared.pdf', organizationId: 'orgA', isDeleted: false });
      folderRepo.findOne.mockResolvedValue({ id: 'fo1', name: 'Shared folder', organizationId: 'orgA', isDeleted: false });
      const res = await service.listSharedWithMe('orgA', 'bob');
      expect(res.files[0]).toMatchObject({ id: 'f1', permission: 'download', sharedByName: 'Alice', grantId: 'g1' });
      expect(res.folders[0]).toMatchObject({ id: 'fo1', permission: 'edit', sharedByName: 'Alice' });
    });

    it('lets the grantee revoke their own grant', async () => {
      grantRepo.findOne.mockResolvedValue({ id: 'g1', organizationId: 'orgA', grantedBy: 'owner1', granteeUserId: 'bob', targetType: 'file', targetId: 'f1' });
      await service.revokeGrant('orgA', 'g1', 'bob');
      expect(grantRepo.delete).toHaveBeenCalledWith({ id: 'g1', organizationId: 'orgA' });
    });
  });

  describe('listGrantedFolder', () => {
    // Subtree: root → sub. Files live directly under root.
    const wireSubtree = () => {
      folderRepo.find.mockImplementation(async (opts: any) =>
        opts?.where?.parentFolderId === 'root' ? [{ id: 'sub', name: 'Sub' }] : [],
      );
      folderRepo.findOne.mockImplementation(async (opts: any) =>
        opts?.where?.id === 'root'
          ? { id: 'root', name: 'Root', parentFolderId: null }
          : null,
      );
      fileRepo.find.mockImplementation(async (opts: any) =>
        opts?.where?.folderId === 'root'
          ? [{ id: 'f1', name: 'sheet.xlsx', size: 100, mimeType: 'application/vnd.ms-excel' }]
          : [],
      );
    };

    it('returns the subtree listing for a valid folder grant', async () => {
      grantRepo.findOne.mockResolvedValue({
        id: 'g1', organizationId: 'orgA', granteeUserId: 'bob', targetType: 'folder', targetId: 'root',
      });
      wireSubtree();
      const res = await service.listGrantedFolder('orgA', 'bob', 'g1', null);
      expect(res.breadcrumb).toEqual([{ id: 'root', name: 'Root' }]);
      expect(res.folders).toEqual([{ id: 'sub', name: 'Sub' }]);
      expect(res.files).toEqual([
        { id: 'f1', name: 'sheet.xlsx', size: 100, mimeType: 'application/vnd.ms-excel' },
      ]);
      // Scoped by the grantee + folder target, org-scoped (not owner-scoped).
      expect(grantRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'g1', organizationId: 'orgA', granteeUserId: 'bob', targetType: 'folder' },
      });
    });

    it('rejects a folder outside the granted subtree', async () => {
      grantRepo.findOne.mockResolvedValue({
        id: 'g1', organizationId: 'orgA', granteeUserId: 'bob', targetType: 'folder', targetId: 'root',
      });
      wireSubtree();
      await expect(
        service.listGrantedFolder('orgA', 'bob', 'g1', 'outside'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404s when the grant is missing / not the grantee / not a folder', async () => {
      grantRepo.findOne.mockResolvedValue(null);
      await expect(
        service.listGrantedFolder('orgA', 'bob', 'nope', null),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('per-file read access (assertCanReadFile)', () => {
    const personal = { id: 'f1', organizationId: 'org1', scope: 'personal', ownerId: 'owner1', folderId: null, isDeleted: false, storageFileId: 'doc1', name: 'salary.pdf' };
    const inFolder = { ...personal, id: 'f2', folderId: 'child' };

    beforeEach(() => { fileRepo.findOne.mockResolvedValue(personal); });

    it('lets the owner read their own personal file', async () => {
      await expect(service.assertCanReadFile('org1', 'f1', 'owner1')).resolves.toMatchObject({ id: 'f1' });
    });

    it('refuses another member — the bug this fixes', async () => {
      await expect(service.assertCanReadFile('org1', 'f1', 'colleague')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows a team-drive file for any member', async () => {
      fileRepo.findOne.mockResolvedValue({ ...personal, scope: 'team', ownerId: null });
      await expect(service.assertCanReadFile('org1', 'f1', 'colleague')).resolves.toBeTruthy();
    });

    it('allows someone the file was shared with directly', async () => {
      grantRepo.findOne.mockResolvedValue({ id: 'g1', targetType: 'file', targetId: 'f1', granteeUserId: 'colleague' });
      await expect(service.assertCanReadFile('org1', 'f1', 'colleague')).resolves.toBeTruthy();
    });

    it('allows a grant on a folder ABOVE the file', async () => {
      fileRepo.findOne.mockResolvedValue(inFolder);
      grantRepo.find.mockResolvedValue([{ targetId: 'root' }]);          // granted the parent
      folderRepo.findOne.mockImplementation(async ({ where }: any) =>
        where.id === 'child' ? { parentFolderId: 'root' } : { parentFolderId: null });
      await expect(service.assertCanReadFile('org1', 'f2', 'colleague')).resolves.toBeTruthy();
    });

    it('still refuses when the grant is on an unrelated folder', async () => {
      fileRepo.findOne.mockResolvedValue(inFolder);
      grantRepo.find.mockResolvedValue([{ targetId: 'someone-elses-folder' }]);
      folderRepo.findOne.mockImplementation(async ({ where }: any) =>
        where.id === 'child' ? { parentFolderId: 'root' } : { parentFolderId: null });
      await expect(service.assertCanReadFile('org1', 'f2', 'colleague')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lets org admins read anything, and trusted server paths pass userId=null', async () => {
      await expect(service.assertCanReadFile('org1', 'f1', 'colleague', true)).resolves.toBeTruthy();
      await expect(service.assertCanReadFile('org1', 'f1', null)).resolves.toBeTruthy();
    });

    it('404s a file from another org', async () => {
      fileRepo.findOne.mockResolvedValue(null);
      await expect(service.assertCanReadFile('org1', 'nope', 'owner1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('downloads and PDF previews go through the same check', async () => {
      await expect(service.getFileStream('org1', 'f1', 'colleague')).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.getPreviewPdf('org1', 'f1', 'colleague')).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.getFileStream('org1', 'f1', 'owner1')).resolves.toBeTruthy();
    });
  });

  describe('listFiles', () => {
    const whereOf = () => fileRepo.findAndCount.mock.calls.at(-1)[0].where;

    it('lists one folder by default (the root when folderId is null)', async () => {
      await service.listFiles('org1', 'personal', 'user1', null);
      expect(whereOf().folderId).toBeDefined();
    });

    it('drops the folder filter when flat, so a picker sees files inside folders', async () => {
      await service.listFiles('org1', 'personal', 'user1', null, 1, 200, { flat: true });
      const where = whereOf();
      expect(where.folderId).toBeUndefined();
      // Still scoped to the caller's own drive — flat must not widen access.
      expect(where.ownerId).toBe('user1');
      expect(where.scope).toBe('personal');
      expect(where.isDeleted).toBe(false);
      expect(where.systemManaged).toBe(false);
    });

    it('narrows by name when a search term is given', async () => {
      await service.listFiles('org1', 'team', 'user1', null, 1, 50, { flat: true, q: ' report ' });
      expect(whereOf().name).toBeDefined();
    });

    it('ignores a blank search term', async () => {
      await service.listFiles('org1', 'team', 'user1', null, 1, 50, { flat: true, q: '   ' });
      expect(whereOf().name).toBeUndefined();
    });
  });
});
