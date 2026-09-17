import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RoleEntity } from '../../auth/entities/role.entity';
import { CreateRoleDto, UpdateRoleDto } from '../dto';
import { DEFAULT_ROLES, ROLE_NAME_TO_TIER } from '../default-roles';

/**
 * Org-scoped custom roles — CRUD over the shared `roles` table (the same rows
 * auth folds into the JWT when a member holds a custom role). Every method is
 * scoped to the acting `orgId`; deletes are soft (isDeleted).
 */
@Injectable()
export class OrgRoleService {
  constructor(
    @InjectRepository(RoleEntity)
    private readonly repo: Repository<RoleEntity>,
  ) {}

  async create(
    orgId: string,
    dto: CreateRoleDto,
    createdBy: string,
  ): Promise<RoleEntity> {
    const existing = await this.repo.findOne({
      where: { organizationId: orgId, name: dto.name.trim(), isDeleted: false },
    });
    if (existing) {
      throw new ConflictException(`A role named '${dto.name.trim()}' already exists`);
    }
    const name = dto.name.trim();
    return this.repo.save(
      this.repo.create({
        organizationId: orgId,
        name,
        displayName: dto.displayName ?? name,
        description: dto.description ?? null,
        departmentId: dto.departmentId ?? null,
        // A custom role maps to the 'employee' tier by default (below admin);
        // known legacy names keep their historical tier.
        tier: ROLE_NAME_TO_TIER[name] ?? 'employee',
        isSystem: false,
        permissions: dto.permissions ?? [],
        createdBy,
      }),
    );
  }

  /**
   * Seed the org's default custom roles (HR, Developer, Designer) — idempotent,
   * skipping any role whose name already exists for the org. There are no
   * built-in tier roles to seed; see the note in default-roles.ts.
   */
  async seedDefaults(orgId: string, createdBy: string): Promise<RoleEntity[]> {
    const existing = await this.repo.find({
      where: { organizationId: orgId, isDeleted: false },
    });
    const have = new Set(existing.map((r) => r.name));
    const toCreate: RoleEntity[] = [];
    for (const r of DEFAULT_ROLES) {
      if (have.has(r.name)) continue;
      toCreate.push(
        this.repo.create({
          organizationId: orgId,
          name: r.name,
          displayName: r.displayName,
          description: r.description,
          departmentId: null,
          tier: r.tier,
          isSystem: false,
          permissions: r.permissions,
          createdBy,
        }),
      );
    }
    if (toCreate.length) await this.repo.save(toCreate);
    return this.list(orgId);
  }

  async list(orgId: string): Promise<RoleEntity[]> {
    return this.repo.find({
      where: { organizationId: orgId, isDeleted: false },
      order: { createdAt: 'ASC' },
    });
  }

  async get(orgId: string, id: string): Promise<RoleEntity> {
    const role = await this.repo.findOne({
      where: { id, organizationId: orgId, isDeleted: false },
    });
    if (!role) throw new NotFoundException('Role not found');
    return role;
  }

  async update(orgId: string, id: string, dto: UpdateRoleDto): Promise<RoleEntity> {
    const role = await this.get(orgId, id);
    if (dto.displayName !== undefined) role.displayName = dto.displayName;
    if (dto.description !== undefined) role.description = dto.description;
    if (dto.permissions !== undefined) role.permissions = dto.permissions;
    // Empty string clears the scope back to org-wide (all departments).
    if (dto.departmentId !== undefined) role.departmentId = dto.departmentId || null;
    return this.repo.save(role);
  }

  async remove(orgId: string, id: string): Promise<void> {
    const role = await this.get(orgId, id);
    if (role.isSystem) {
      throw new BadRequestException('Built-in system roles cannot be deleted');
    }
    role.isDeleted = true;
    await this.repo.save(role);
  }
}
