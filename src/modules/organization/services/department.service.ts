import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DepartmentEntity } from '../entities/department.entity';
import { CreateDepartmentDto, UpdateDepartmentDto } from '../dto';

/**
 * Departments — org-scoped CRUD. Every method takes the acting `orgId` (from the
 * JWT, never the client) so a session can only touch its own org's departments.
 * Deletes are soft (isDeleted) to preserve references from members/roles.
 */
@Injectable()
export class DepartmentService {
  constructor(
    @InjectRepository(DepartmentEntity)
    private readonly repo: Repository<DepartmentEntity>,
  ) {}

  async create(
    orgId: string,
    dto: CreateDepartmentDto,
    createdBy: string,
  ): Promise<DepartmentEntity> {
    const existing = await this.repo.findOne({
      where: { organizationId: orgId, name: dto.name.trim(), isDeleted: false },
    });
    if (existing) {
      throw new ConflictException(
        `A department named '${dto.name.trim()}' already exists`,
      );
    }
    const code = dto.code?.trim().toUpperCase() || null;
    if (code) {
      const dup = await this.repo.findOne({
        where: { organizationId: orgId, code, isDeleted: false },
      });
      if (dup) {
        throw new ConflictException(`A department with code '${code}' already exists`);
      }
    }
    return this.repo.save(
      this.repo.create({
        organizationId: orgId,
        name: dto.name.trim(),
        code,
        description: dto.description ?? null,
        headUserId: dto.headUserId || null,
        parentDepartmentId: dto.parentDepartmentId || null,
        costCenter: dto.costCenter?.trim() || null,
        createdBy,
      }),
    );
  }

  async list(orgId: string): Promise<DepartmentEntity[]> {
    return this.repo.find({
      where: { organizationId: orgId, isDeleted: false },
      order: { createdAt: 'ASC' },
    });
  }

  async get(orgId: string, id: string): Promise<DepartmentEntity> {
    const dept = await this.repo.findOne({
      where: { id, organizationId: orgId, isDeleted: false },
    });
    if (!dept) throw new NotFoundException('Department not found');
    return dept;
  }

  async update(
    orgId: string,
    id: string,
    dto: UpdateDepartmentDto,
  ): Promise<DepartmentEntity> {
    const dept = await this.get(orgId, id);
    if (dto.name !== undefined) dept.name = dto.name.trim();
    if (dto.code !== undefined) dept.code = dto.code?.trim().toUpperCase() || null;
    if (dto.description !== undefined) dept.description = dto.description;
    if (dto.headUserId !== undefined) dept.headUserId = dto.headUserId || null;
    if (dto.parentDepartmentId !== undefined)
      dept.parentDepartmentId = dto.parentDepartmentId || null;
    if (dto.costCenter !== undefined) dept.costCenter = dto.costCenter?.trim() || null;
    return this.repo.save(dept);
  }

  async remove(orgId: string, id: string): Promise<void> {
    const dept = await this.get(orgId, id);
    dept.isDeleted = true;
    await this.repo.save(dept);
  }
}
