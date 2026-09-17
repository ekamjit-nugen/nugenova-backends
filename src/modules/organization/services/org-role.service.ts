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
import {
  DEFAULT_ROLES,
  ROLE_NAME_TO_TIER,
  SYSTEM_ROLES,
  RESERVED_ROLE_NAMES,
  LOCKED_SYSTEM_ROLE_NAMES,
} from '../default-roles';

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
    if (RESERVED_ROLE_NAMES.has(name)) {
      throw new ConflictException(`'${name}' is a reserved built-in role name`);
    }
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
   * Seed the org's roles — idempotent. Creates the SYSTEM roles that back the
   * standard tiers (Owner/Admin/Manager/Employee/Member/Viewer) so every tier is
   * a real, visible row, PLUS the default custom roles (HR, Developer, Designer).
   * Skips any role whose name already exists for the org.
   */
  async seedDefaults(orgId: string, createdBy: string): Promise<RoleEntity[]> {
    const existing = await this.repo.find({
      where: { organizationId: orgId, isDeleted: false },
    });
    const have = new Set(existing.map((r) => r.name));
    const toCreate: RoleEntity[] = [];
    for (const r of SYSTEM_ROLES) {
      if (have.has(r.name)) continue;
      toCreate.push(
        this.repo.create({
          organizationId: orgId,
          name: r.name,
          displayName: r.displayName,
          description: r.description,
          departmentId: null,
          tier: r.tier,
          isSystem: true,
          permissions: r.permissions,
          createdBy,
        }),
      );
    }
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

  /** The org's system role for a given tier (e.g. 'manager' → the Manager row). */
  async systemRoleForTier(orgId: string, tier: string): Promise<RoleEntity | null> {
    return this.repo.findOne({
      where: { organizationId: orgId, tier, isSystem: true, isDeleted: false },
    });
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
    // Owner/Admin are full-access and locked — editing them risks a lockout.
    if (role.isSystem && LOCKED_SYSTEM_ROLE_NAMES.has(role.name)) {
      throw new BadRequestException(`The ${role.displayName} role is built-in and cannot be edited`);
    }
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
