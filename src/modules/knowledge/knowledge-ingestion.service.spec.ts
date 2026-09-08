import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { KnowledgeIngestionService } from './knowledge-ingestion.service';
import { KnowledgeChunkEntity } from './entities/knowledge-chunk.entity';
import { DriveFileEntity } from '../storage/entities/drive-file.entity';
import { DocumentFileEntity } from '../../bootstrap/storage/document-file.entity';
import { StorageService } from '../../bootstrap/storage/storage.service';

/**
 * Unit specs for ingestion. Repos + StorageService are mocked (no DB, no bytes
 * on the wire). Pins: re-indexing a source REPLACES its chunks (delete-then-
 * insert, never duplicate), private 'My Drive' files are excluded from the org
 * corpus, and unextractable/binary files are skipped without writing.
 */
describe('KnowledgeIngestionService', () => {
  let service: KnowledgeIngestionService;

  const chunkRepo = {
    delete: jest.fn().mockResolvedValue(undefined),
    create: jest.fn((row: any) => row),
    save: jest.fn().mockResolvedValue(undefined),
    find: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
  const driveRepo = { findOne: jest.fn(), find: jest.fn() };
  const docRepo = { findOne: jest.fn() };
  const storage = { getMeta: jest.fn(), getBytes: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        KnowledgeIngestionService,
        { provide: getRepositoryToken(KnowledgeChunkEntity), useValue: chunkRepo },
        { provide: getRepositoryToken(DriveFileEntity), useValue: driveRepo },
        { provide: getRepositoryToken(DocumentFileEntity), useValue: docRepo },
        { provide: StorageService, useValue: storage },
      ],
    }).compile();
    service = moduleRef.get(KnowledgeIngestionService);
  });

  it('replaces (not duplicates) a source\'s chunks on re-index', async () => {
    driveRepo.findOne.mockResolvedValue({
      id: 'drive1',
      organizationId: 'orgA',
      name: 'Handbook.txt',
      scope: 'team',
      storageFileId: 'store1',
      mimeType: 'text/plain',
      isDeleted: false,
    });
    storage.getMeta.mockResolvedValue({ id: 'store1' });
    storage.getBytes.mockResolvedValue(Buffer.from('vacation policy grants twenty paid days off each year'));

    const first = await service.indexDocument('orgA', 'drive1');
    expect(first.status).toBe('indexed');
    expect(first.chunks).toBeGreaterThanOrEqual(1);

    // A second index of the same source must DELETE the old rows first, then
    // insert — so the source never accumulates duplicate chunks.
    await service.indexDocument('orgA', 'drive1');

    expect(chunkRepo.delete).toHaveBeenCalledWith({ organizationId: 'orgA', sourceId: 'drive1' });
    expect(chunkRepo.delete).toHaveBeenCalledTimes(2);
    // Every inserted row has a distinct chunkIndex within a single index call.
    const rows = chunkRepo.save.mock.calls[0][0] as Array<{ chunkIndex: number; sourceId: string }>;
    const indexes = rows.map((r) => r.chunkIndex);
    expect(new Set(indexes).size).toBe(indexes.length);
    expect(rows.every((r) => r.sourceId === 'drive1')).toBe(true);
  });

  it('EXCLUDES a private My Drive (personal-scope) file from the org corpus', async () => {
    driveRepo.findOne.mockResolvedValue({
      id: 'drivePriv',
      organizationId: 'orgA',
      name: 'secret.txt',
      scope: 'personal',
      ownerId: 'u1',
      storageFileId: 'storeP',
      mimeType: 'text/plain',
      isDeleted: false,
    });

    const out = await service.indexDocument('orgA', 'drivePriv');
    expect(out.status).toBe('skipped');
    expect(out.reason).toMatch(/personal/i);
    // Never fetched bytes, never wrote chunks for a private file.
    expect(storage.getBytes).not.toHaveBeenCalled();
    expect(chunkRepo.delete).not.toHaveBeenCalled();
    expect(chunkRepo.save).not.toHaveBeenCalled();
  });

  it('skips a binary/unextractable file without writing', async () => {
    driveRepo.findOne.mockResolvedValue({
      id: 'driveBin',
      organizationId: 'orgA',
      name: 'image.bin',
      scope: 'team',
      storageFileId: 'storeB',
      mimeType: 'application/octet-stream',
      isDeleted: false,
    });
    storage.getMeta.mockResolvedValue({ id: 'storeB' });
    storage.getBytes.mockResolvedValue(Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]));

    const out = await service.indexDocument('orgA', 'driveBin');
    expect(out.status).toBe('skipped');
    expect(chunkRepo.save).not.toHaveBeenCalled();
  });

  it('resolves a document_files source when the ref is not a drive file', async () => {
    driveRepo.findOne.mockResolvedValue(null);
    docRepo.findOne.mockResolvedValue({
      id: 'doc1',
      organizationId: 'orgA',
      originalName: 'onboarding.md',
      mimeType: 'text/markdown',
      isDeleted: false,
    });
    storage.getMeta.mockResolvedValue({ id: 'doc1' });
    storage.getBytes.mockResolvedValue(Buffer.from('# Welcome\nOnboarding steps and org policies here.'));

    const out = await service.indexDocument('orgA', 'doc1');
    expect(out.status).toBe('indexed');
    const rows = chunkRepo.save.mock.calls[0][0] as Array<{ sourceType: string }>;
    expect(rows[0].sourceType).toBe('document_file');
  });

  it('reindexOrg only scans team-scope files and prunes removed sources', async () => {
    const teamFile = { id: 'drive1', organizationId: 'orgA', name: 'A.txt', scope: 'team', storageFileId: 's1', mimeType: 'text/plain', isDeleted: false };
    driveRepo.find.mockResolvedValue([teamFile]);
    driveRepo.findOne.mockResolvedValue(teamFile); // indexDocument re-resolves by id
    storage.getMeta.mockResolvedValue({ id: 's1' });
    storage.getBytes.mockResolvedValue(Buffer.from('policy content for team drive file'));
    const del = { where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(), execute: jest.fn().mockResolvedValue(undefined) };
    chunkRepo.createQueryBuilder.mockReturnValue({ delete: () => del });

    const res = await service.reindexOrg('orgA');

    expect(driveRepo.find).toHaveBeenCalledWith({ where: { organizationId: 'orgA', scope: 'team', isDeleted: false } });
    expect(res.documents).toBe(1);
    expect(res.chunks).toBeGreaterThanOrEqual(1);
    // Prune keeps the just-indexed source and drops everything else for the org.
    expect(del.andWhere).toHaveBeenCalledWith('source_id NOT IN (:...keepSourceIds)', { keepSourceIds: ['drive1'] });
  });
});
