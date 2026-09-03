import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { randomUUID } from 'crypto';

import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';
import { staffScope } from '../../auth/entities/person-type';
import { UserEntity } from '../../auth/entities/user.entity';
import { RoleEntity } from '../../auth/entities/role.entity';
import { AddMemberDto } from '../dto';
import { ROLE_NAME_TO_TIER } from '../default-roles';

export interface MemberView {
  membershipId: string;
  userId: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  role: string;
  roleId: string | null;
  secondaryRoleId: string | null;
  departmentId: string | null;
  status: string;
  joinedAt: Date | null;
}

/**
 * Team membership — the people half of org setup. Adding a member resolves (or
 * creates) the user, then attaches an active org membership carrying the
 * enforced tier, optional custom role, and department. Scoped to the acting
 * `orgId` throughout.
 */
@Injectable()
export class MembershipService {
  constructor(
    @InjectRepository(OrgMembershipEntity)
    private readonly membershipRepo: Repository<OrgMembershipEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    @InjectRepository(RoleEntity)
    private readonly roleRepo: Repository<RoleEntity>,
  ) {}

  /**
   * Resolve the enforced tier + validated custom role for a new/updated member.
   * A custom role (`roleId`) scoped to a department may only be assigned to a
   * member of that same department (the department↔role relation). When no tier
   * is given, it's derived from the custom role (else defaults to `employee`).
   */
  private async resolveRole(
    orgId: string,
    input: { role?: string; roleId?: string; departmentId?: string },
  ): Promise<{ tier: string; roleId: string | null; departmentId: string | null }> {
    // No custom role picked → attach the SYSTEM role for the requested tier, so
    // every member holds a real, visible role row (never a bare tier). Falls
    // back to the raw tier only if the org has no seeded system role (legacy).
    if (!input.roleId) {
      const tier = input.role || 'employee';
      const sys = await this.roleRepo.findOne({
        where: { organizationId: orgId, tier, isSystem: true, isDeleted: false },
      });
      return {
        tier,
        roleId: sys?.id ?? null,
        departmentId: input.departmentId ?? null,
      };
    }
    const role = await this.roleRepo.findOne({
      where: { id: input.roleId, organizationId: orgId, isDeleted: false },
    });
    if (!role) throw new NotFoundException('Role not found for this organization');
    if (
      role.departmentId &&
      input.departmentId &&
      role.departmentId !== input.departmentId
    ) {
      throw new BadRequestException(
        'That role belongs to a different department than this member. ' +
          'Pick a role from the same department (or an org-wide role).',
      );
    }
    // Tier is DERIVED from the assigned role (its `tier`, then legacy name map).
    const tier = role.tier || ROLE_NAME_TO_TIER[role.name] || input.role || 'employee';
    // A department-scoped role coherently places the member in that department
    // (an explicit departmentId wins; validated equal above).
    const departmentId = input.departmentId ?? role.departmentId ?? null;
    return { tier, roleId: role.id, departmentId };
  }

  async addMember(
    orgId: string,
    dto: AddMemberDto,
    invitedBy: string,
  ): Promise<MemberView> {
    const email = dto.email.toLowerCase();

    let user = await this.userRepo.findOne({ where: { email } });
    if (!user) {
      user = await this.userRepo.save(
        this.userRepo.create({
          email,
          password: 'pending-otp-' + randomUUID(),
          firstName: dto.firstName || 'Member',
          lastName: dto.lastName || '',
          isActive: true,
          setupStage: 'complete',
        }),
      );
    }

    const existing = await this.membershipRepo.findOne({
      where: { organizationId: orgId, userId: user.id },
    });
    if (existing) {
      throw new ConflictException('This person is already a member of the organization');
    }

    // Resolve the enforced tier from the (optional) custom role + validate the
    // department↔role relation before writing the membership.
    const resolved = await this.resolveRole(orgId, {
      role: dto.role,
      roleId: dto.roleId,
      departmentId: dto.departmentId,
    });

    const membership = await this.membershipRepo.save(
      this.membershipRepo.create({
        userId: user.id,
        email,
        organizationId: orgId,
        role: resolved.tier,
        roleId: resolved.roleId,
        departmentId: resolved.departmentId,
        status: 'active',
        invitedBy,
        joinedAt: new Date(),
      }),
    );

    // Reflect the org on the user's denormalized list.
    const orgs = new Set(user.organizations || []);
    orgs.add(orgId);
    user.organizations = [...orgs];
    if (!user.defaultOrganizationId) user.defaultOrganizationId = orgId;
    await this.userRepo.save(user);

    return this.toView(membership, user);
  }

  async list(orgId: string): Promise<MemberView[]> {
    // staffScope: the org directory is the STAFF roster. Students/guardians (the
    // education vertical) live in the same table but are enumerated through their
    // own surfaces, never this member list.
    const memberships = await this.membershipRepo.find({
      where: staffScope({ organizationId: orgId }),
      order: { createdAt: 'ASC' },
    });
    const userIds = memberships.map((m) => m.userId).filter(Boolean) as string[];
    const users = userIds.length
      ? await this.userRepo.find({ where: { id: In(userIds) } })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    return memberships.map((m) =>
      this.toView(m, m.userId ? byId.get(m.userId) : undefined),
    );
  }

  async get(orgId: string, membershipId: string): Promise<MemberView> {
    const m = await this.membershipRepo.findOne({
      where: { id: membershipId, organizationId: orgId },
    });
    if (!m) throw new NotFoundException('Member not found');
    const user = m.userId
      ? await this.userRepo.findOne({ where: { id: m.userId } })
      : null;
    return this.toView(m, user || undefined);
  }

  async updateMember(
    orgId: string,
    membershipId: string,
    patch: { role?: string; roleId?: string | null; departmentId?: string | null },
  ): Promise<MemberView> {
    const m = await this.membershipRepo.findOne({
      where: { id: membershipId, organizationId: orgId },
    });
    if (!m) throw new NotFoundException('Member not found');

    // Apply the department first so role↔department validation sees the new dept.
    if (patch.departmentId !== undefined) m.departmentId = patch.departmentId || null;

    if (patch.roleId !== undefined) {
      if (!patch.roleId) {
        // Clearing the custom role — attach the SYSTEM role for the tier so the
        // member still holds a real, visible role row (not a bare tier).
        const tier = patch.role ?? m.role;
        const resolved = await this.resolveRole(orgId, { role: tier });
        m.role = resolved.tier;
        m.roleId = resolved.roleId;
      } else {
        // Assigning a custom role: derive the enforced tier + validate that a
        // department-scoped role matches this member's department (mirrors add).
        const resolved = await this.resolveRole(orgId, {
          role: patch.role,
          roleId: patch.roleId,
          departmentId: m.departmentId ?? undefined,
        });
        m.roleId = resolved.roleId;
        m.role = resolved.tier;
        // A dept-scoped role also places the member in that department.
        if (patch.departmentId === undefined && resolved.departmentId) {
          m.departmentId = resolved.departmentId;
        }
      }
    } else if (patch.role !== undefined) {
      // Only the tier changed (e.g. the Directory's inline role switch) — keep
      // roleId pointing at that tier's system role.
      const resolved = await this.resolveRole(orgId, { role: patch.role });
      m.role = resolved.tier;
      m.roleId = resolved.roleId;
    }

    await this.membershipRepo.save(m);
    const user = m.userId
      ? await this.userRepo.findOne({ where: { id: m.userId } })
      : null;
    return this.toView(m, user || undefined);
  }

  async removeMember(orgId: string, membershipId: string): Promise<void> {
    const m = await this.membershipRepo.findOne({
      where: { id: membershipId, organizationId: orgId },
    });
    if (!m) throw new NotFoundException('Member not found');
    if (m.role === 'owner') {
      throw new ConflictException('The organization owner cannot be removed');
    }
    await this.membershipRepo.delete({ id: membershipId, organizationId: orgId });
  }

  private toView(m: OrgMembershipEntity, user?: UserEntity): MemberView {
    return {
      membershipId: m.id,
      userId: m.userId,
      email: m.email || user?.email || null,
      firstName: user?.firstName ?? null,
      lastName: user?.lastName ?? null,
      role: m.role,
      roleId: m.roleId,
      secondaryRoleId: m.secondaryRoleId ?? null,
      departmentId: m.departmentId ?? null,
      status: m.status,
      joinedAt: m.joinedAt,
    };
  }
}
