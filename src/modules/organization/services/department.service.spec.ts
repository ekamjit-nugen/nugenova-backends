import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';

import { DepartmentService } from './department.service';
import { DepartmentEntity } from '../entities/department.entity';

/**
 * Pure unit specs — NO database. The repository is a jest mock, so these run
 * under `npm test`. Covers DepartmentService: org-scoped create with the
 * duplicate-name conflict, and the soft delete (isDeleted flag, not a row drop).
 */
describe('DepartmentService (unit, no DB)', () => {
  let service: DepartmentService;
  let repo: any;

  beforeEach(async () => {
    repo = {
      create: jest.fn((v) => ({ ...v })),
      save: jest.fn(async (v) => ({ id: v.id ?? 'dept-1', ...v })),
      findOne: jest.fn(),
      find: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        DepartmentService,
        { provide: getRepositoryToken(DepartmentEntity), useValue: repo },
      ],
    }).compile();

    service = moduleRef.get(DepartmentService);
  });

  describe('create', () => {
    it('creates an org-scoped department when the name is free', async () => {
      repo.findOne.mockResolvedValue(null);

      await service.create('org-1', { name: '  Engineering  ' } as any, 'user-1');

      expect(repo.findOne).toHaveBeenCalledWith({
        where: { organizationId: 'org-1', name: 'Engineering', isDeleted: false },
      });
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: 'org-1',
          name: 'Engineering',
          createdBy: 'user-1',
        }),
      );
      expect(repo.save).toHaveBeenCalled();
    });

    it('rejects a duplicate department name in the same org', async () => {
      repo.findOne.mockResolvedValue({ id: 'existing', name: 'Engineering' });

      await expect(
        service.create('org-1', { name: 'Engineering' } as any, 'user-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  describe('remove (soft delete)', () => {
    it('flags the department as deleted and saves it (no hard delete)', async () => {
      const dept = {
        id: 'dept-1',
        organizationId: 'org-1',
        name: 'Legacy',
        isDeleted: false,
      };
      repo.findOne.mockResolvedValue(dept);

      await service.remove('org-1', 'dept-1');

      expect(dept.isDeleted).toBe(true);
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'dept-1', isDeleted: true }),
      );
    });

    it('404s when the department is missing or in another org', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(service.remove('org-1', 'nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
