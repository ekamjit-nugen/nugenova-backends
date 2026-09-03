import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { TermsService } from './terms.service';
import { PlatformTermsEntity } from './entities/platform-terms.entity';
import { StorageService } from '../../bootstrap/storage/storage.service';

/**
 * Pure unit specs — NO database. Covers validation, versioning, the in-memory
 * version cache, and the security-critical `needsConsent` decision.
 */
describe('TermsService (unit, no DB)', () => {
  let service: TermsService;
  let repo: any;

  const build = async () => {
    repo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      count: jest.fn(),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn((v) => ({ ...v })),
      save: jest.fn(async (v) => ({ id: v.id ?? 't1', updatedAt: new Date(), ...v })),
      // activate() runs its two flips inside a transaction.
      manager: {
        transaction: jest.fn(async (cb: any) =>
          cb({ update: jest.fn().mockResolvedValue({}) }),
        ),
      },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        TermsService,
        { provide: getRepositoryToken(PlatformTermsEntity), useValue: repo },
        { provide: StorageService, useValue: { getMeta: jest.fn(), getBytes: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(TermsService);
  };

  beforeEach(build);

  describe('create + validate', () => {
    it('rejects an HTML T&C whose text is too short', async () => {
      await expect(
        service.create({ title: 'X', kind: 'html', text: 'short' }, 'admin'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a PDF T&C with no file', async () => {
      await expect(
        service.create({ title: 'X', kind: 'pdf' }, 'admin'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates an HTML T&C at version 1, caches its version, and publishes it active', async () => {
      const row = {
        id: 't1',
        title: 'Standard',
        version: 1,
        kind: 'html',
        text: 'These are the terms.',
        fileId: null,
        isActive: true,
        updatedAt: new Date(),
      };
      repo.save.mockResolvedValueOnce(row);
      repo.findOne.mockResolvedValue(row); // activate() + get()
      repo.find.mockResolvedValue([{ id: 't1', version: 1, isActive: true }]);
      const doc = await service.create(
        { title: 'Standard', kind: 'html', text: 'These are the terms.' },
        'admin',
      );
      expect(doc.version).toBe(1);
      expect(doc.isActive).toBe(true);
      expect(service.getVersion('t1')).toBe(1);
      // Creating publishes it as the single active platform T&C.
      expect(service.getActive()).toEqual({ id: 't1', version: 1 });
    });
  });

  describe('needsConsentActive (the platform-wide gate)', () => {
    beforeEach(async () => {
      // Warm the cache: t1 is the active T&C at version 3.
      repo.find.mockResolvedValueOnce([{ id: 't1', version: 3, isActive: true }]);
      await service.onModuleInit();
    });

    it('no active T&C configured → nobody is gated', async () => {
      repo.find.mockResolvedValueOnce([]);
      await service.onModuleInit();
      expect(service.needsConsentActive(null)).toBe(false);
      expect(service.needsConsentActive({ termsId: 't1', version: 3 })).toBe(false);
    });

    it('active T&C + never consented → must consent', () => {
      expect(service.needsConsentActive(null)).toBe(true);
    });

    it('consented to a DIFFERENT document → must re-consent', () => {
      expect(service.needsConsentActive({ termsId: 'old', version: 3 })).toBe(true);
    });

    it('consented to an OLDER version of the active doc → must re-consent', () => {
      expect(service.needsConsentActive({ termsId: 't1', version: 2 })).toBe(true);
    });

    it('consented to the active document at its current version → no gate', () => {
      expect(service.needsConsentActive({ termsId: 't1', version: 3 })).toBe(false);
    });
  });

  describe('update', () => {
    it('bumps the version and refreshes the cache', async () => {
      repo.findOne.mockResolvedValueOnce({ id: 't1', title: 'S', version: 1, kind: 'html', text: 'x' });
      repo.save.mockImplementationOnce(async (r: any) => ({ ...r, updatedAt: new Date() }));
      const doc = await service.update(
        't1',
        { title: 'S', kind: 'html', text: 'updated terms text' },
        'admin',
      );
      expect(doc.version).toBe(2);
      expect(service.getVersion('t1')).toBe(2);
    });

    it('404s when editing a missing document', async () => {
      repo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.update('nope', { title: 'S', kind: 'html', text: 'long enough text' }, 'admin'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });


  describe('remove', () => {
    it('deletes the row and drops it from the cache', async () => {
      repo.find.mockResolvedValueOnce([{ id: 't1', version: 1 }]);
      await service.onModuleInit();
      repo.findOne.mockResolvedValueOnce({ id: 't1', title: 'S' });
      await service.remove('t1');
      expect(repo.delete).toHaveBeenCalledWith({ id: 't1' });
      expect(service.getVersion('t1')).toBeNull();
    });
  });
});
