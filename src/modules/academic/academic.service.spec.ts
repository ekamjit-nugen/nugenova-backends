import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { AcademicService } from './academic.service';
import { AcademicYearEntity } from './entities/academic-year.entity';
import { TermEntity } from './entities/term.entity';

/**
 * Pure unit specs — NO database. Covers date validation, the one-current-year
 * invariant (the transaction clears every other year first), term ordering /
 * sequence uniqueness, and within-year term bounds.
 */
describe('AcademicService (unit, no DB)', () => {
  let service: AcademicService;
  let years: any;
  let terms: any;
  let tx: any;

  const yearRow = (over: Partial<AcademicYearEntity> = {}): any => ({
    id: 'y1',
    organizationId: 'org1',
    name: '2025-26',
    startDate: '2025-06-01',
    endDate: '2026-05-31',
    isCurrent: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });

  beforeEach(async () => {
    tx = {
      save: jest.fn(async (_e: any, v: any) => ({ id: v.id ?? 'y1', ...v })),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    };
    const manager = { transaction: jest.fn(async (cb: any) => cb(tx)) };
    years = {
      create: jest.fn((v) => ({ ...v })),
      save: jest.fn(async (v) => ({ id: v.id ?? 'y1', createdAt: new Date(), updatedAt: new Date(), ...v })),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      manager,
    };
    terms = {
      create: jest.fn((v) => ({ ...v })),
      save: jest.fn(async (v) => ({ id: v.id ?? 't1', createdAt: new Date(), updatedAt: new Date(), ...v })),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AcademicService,
        { provide: getRepositoryToken(AcademicYearEntity), useValue: years },
        { provide: getRepositoryToken(TermEntity), useValue: terms },
      ],
    }).compile();
    service = moduleRef.get(AcademicService);
  });

  describe('createYear', () => {
    it('rejects a year whose start is not before its end', async () => {
      await expect(
        service.createYear('org1', { name: 'X', startDate: '2026-01-01', endDate: '2025-01-01' }, 'admin'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates a plain (non-current) year without clearing others', async () => {
      const y = await service.createYear(
        'org1',
        { name: '2025-26', startDate: '2025-06-01', endDate: '2026-05-31' },
        'admin',
      );
      expect(y.isCurrent).toBe(false);
      expect(tx.update).not.toHaveBeenCalled();
    });

    it('when created current, clears every other current year first (one-current rule)', async () => {
      const y = await service.createYear(
        'org1',
        { name: '2025-26', startDate: '2025-06-01', endDate: '2026-05-31', isCurrent: true },
        'admin',
      );
      expect(y.isCurrent).toBe(true);
      // First flip clears all current years in the org, second sets this one.
      expect(tx.update).toHaveBeenNthCalledWith(
        1,
        AcademicYearEntity,
        { organizationId: 'org1', isCurrent: true },
        { isCurrent: false },
      );
      expect(tx.update).toHaveBeenNthCalledWith(
        2,
        AcademicYearEntity,
        { id: expect.any(String) },
        { isCurrent: true },
      );
    });
  });

  describe('setCurrentYear', () => {
    it('404s when the year is not in the org', async () => {
      years.findOne.mockResolvedValue(null);
      await expect(service.setCurrentYear('org1', 'nope', 'admin')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('clears others then promotes the chosen year', async () => {
      years.findOne.mockResolvedValue(yearRow());
      await service.setCurrentYear('org1', 'y1', 'admin');
      expect(tx.update).toHaveBeenNthCalledWith(
        1,
        AcademicYearEntity,
        { organizationId: 'org1', isCurrent: true },
        { isCurrent: false },
      );
    });
  });

  describe('createTerm', () => {
    it('404s when the parent year is not in the org', async () => {
      years.findOne.mockResolvedValue(null);
      await expect(
        service.createTerm('org1', 'y1', { name: 'T1', startDate: '2025-06-01', endDate: '2025-09-30' }, 'admin'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a term whose dates fall outside the academic year', async () => {
      years.findOne.mockResolvedValue(yearRow());
      await expect(
        service.createTerm('org1', 'y1', { name: 'T1', startDate: '2025-05-01', endDate: '2025-09-30' }, 'admin'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('auto-appends the next sequence when omitted', async () => {
      years.findOne.mockResolvedValue(yearRow());
      terms.find.mockResolvedValue([{ sequence: 1 }, { sequence: 2 }]);
      const t = await service.createTerm(
        'org1',
        'y1',
        { name: 'T3', startDate: '2025-10-01', endDate: '2025-12-31' },
        'admin',
      );
      expect(t.sequence).toBe(3);
    });

    it('rejects a duplicate sequence within the same year (ordered terms)', async () => {
      years.findOne.mockResolvedValue(yearRow());
      terms.find.mockResolvedValue([{ sequence: 1 }]);
      await expect(
        service.createTerm(
          'org1',
          'y1',
          { name: 'Dup', startDate: '2025-06-01', endDate: '2025-09-30', sequence: 1 },
          'admin',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
