import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { randomUUID } from 'crypto';

import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';
import { UserEntity } from '../../auth/entities/user.entity';
import { AddMemberDto } from '../dto';

export interface MemberView {
  membershipId: string;
  userId: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  role: string;
  roleId: string | null;
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
  ) {}

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

    const membership = await this.membershipRepo.save(
      this.membershipRepo.create({
        userId: user.id,
        email,
        organizationId: orgId,
        role: dto.role || 'employee',
        roleId: dto.roleId ?? null,
        departmentId: dto.departmentId ?? null,
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
    const memberships = await this.membershipRepo.find({
      where: { organizationId: orgId },
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
    if (patch.role !== undefined) m.role = patch.role;
    if (patch.roleId !== undefined) m.roleId = patch.roleId || null;
    if (patch.departmentId !== undefined) m.departmentId = patch.departmentId || null;
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
      departmentId: m.departmentId ?? null,
      status: m.status,
      joinedAt: m.joinedAt,
    };
  }
}
