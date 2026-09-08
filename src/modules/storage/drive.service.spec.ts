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
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { DocumentFileEntity } from '../../bootstrap/storage/document-file.entity';
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
  let membershipRepo: any;
  let documentFileRepo: any;
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
    membershipRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockImplementation(async (x) => x),
    };
    documentFileRepo = {
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
        { provide: getRepositoryToken(OrgMembershipEntity), useValue: membershipRepo },
        { provide: getRepositoryToken(DocumentFileEntity), useValue: documentFileRepo },
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

  describe('bridge (chat/onboarding → Team Drive)', () => {
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

    it('indexes a document_files row into Team Drive under the category folder', async () => {
      documentFileRepo.findOne.mockResolvedValue(doc());
      const row = await service.bridgeDocumentFile('doc9', { organizationId: 'orgA' });
      // Landed the "Shared in Chat" team folder + a team-scope drive file.
      expect(folderRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Shared in Chat', scope: 'team', ownerId: null }),
      );
      expect(row).toMatchObject({
        storageFileId: 'doc9',
        scope: 'team',
        ownerId: null,
        name: 'secret.png',
        systemManaged: false,
      });
    });

    it('is idempotent — an existing drive row for the same bytes is reused, not duplicated', async () => {
      fileRepo.findOne.mockResolvedValue({ id: 'existing', storageFileId: 'doc9' });
      const row = await service.bridgeDocumentFile('doc9');
      expect(row).toMatchObject({ id: 'existing' });
      expect(fileRepo.save).not.toHaveBeenCalled();
      expect(documentFileRepo.findOne).not.toHaveBeenCalled();
    });

    it('never re-indexes a drive-native file, and guards cross-org', async () => {
      documentFileRepo.findOne.mockResolvedValue(doc({ category: 'drive' }));
      expect(await service.bridgeDocumentFile('doc9')).toBeNull();
      documentFileRepo.findOne.mockResolvedValue(doc({ organizationId: 'orgB' }));
      expect(await service.bridgeDocumentFile('doc9', { organizationId: 'orgA' })).toBeNull();
      expect(fileRepo.save).not.toHaveBeenCalled();
    });

    it('backfill scans the org, linking only not-yet-bridged non-drive files', async () => {
      documentFileRepo.find.mockResolvedValue([
        doc({ id: 'd1', category: 'chat' }),
        doc({ id: 'd2', category: 'drive' }), // already drive-native → skip
        doc({ id: 'd3', category: 'onboarding' }),
      ]);
      // d1 has no existing row; d3 already bridged.
      fileRepo.findOne.mockImplementation(async ({ where }: any) =>
        where.storageFileId === 'd3' ? { id: 'already' } : null,
      );
      // bridgeDocumentFile re-fetches the source doc by id.
      documentFileRepo.findOne.mockImplementation(async ({ where }: any) =>
        doc({ id: where.id, category: 'chat' }),
      );
      const res = await service.backfillFromStorage('orgA');
      expect(res.scanned).toBe(3);
      expect(res.linked).toBe(1); // only d1
      expect(res.skipped).toBe(2); // d2 (drive) + d3 (already)
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
});
