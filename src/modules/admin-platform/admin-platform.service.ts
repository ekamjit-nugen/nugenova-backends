import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { OrganizationEntity } from '../organization/entities/organization.entity';
import { DepartmentEntity } from '../organization/entities/department.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { PolicyEntity } from '../policy/entities/policy.entity';
import { AttendanceEntity } from '../attendance/entities/attendance.entity';
import { WfhRequestEntity } from '../attendance/entities/wfh-request.entity';
import { MemberOnboardingEntity } from '../onboarding/entities/member-onboarding.entity';
import { NotificationEntity } from '../notification/entities/notification.entity';

const DAY = 86_400_000;

/** A `{ orgId → count }` map built from a single grouped query (no N+1). */
type CountMap = Map<string, number>;

/**
 * AdminPlatformService — platform-wide usage aggregation for the super admin.
 * Every number is cross-tenant (the super admin is the only caller, gated by the
 * PlatformAdminGuard), computed with grouped queries rather than per-org loops.
 */
@Injectable()
export class AdminPlatformService {
  constructor(
    @InjectRepository(OrganizationEntity)
    private readonly orgs: Repository<OrganizationEntity>,
    @InjectRepository(DepartmentEntity)
    private readonly departments: Repository<DepartmentEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    @InjectRepository(OrgMembershipEntity)
    private readonly memberships: Repository<OrgMembershipEntity>,
    @InjectRepository(PolicyEntity)
    private readonly policies: Repository<PolicyEntity>,
    @InjectRepository(AttendanceEntity)
    private readonly attendance: Repository<AttendanceEntity>,
    @InjectRepository(WfhRequestEntity)
    private readonly wfh: Repository<WfhRequestEntity>,
    @InjectRepository(MemberOnboardingEntity)
    private readonly onboardings: Repository<MemberOnboardingEntity>,
    @InjectRepository(NotificationEntity)
    private readonly notifications: Repository<NotificationEntity>,
  ) {}

  /** COUNT(*) grouped by an org column → Map(orgId → count). */
  private async countByOrg(
    repo: Repository<any>,
    where?: (qb: any) => void,
  ): Promise<CountMap> {
    const qb = repo
      .createQueryBuilder('e')
      .select('e.organizationId', 'orgId')
      .addSelect('COUNT(*)', 'count')
      .groupBy('e.organizationId');
    if (where) where(qb);
    const rows = await qb.getRawMany<{ orgId: string; count: string }>();
    return new Map(rows.map((r) => [r.orgId, Number(r.count)]));
  }

  async getUsage() {
    const now = Date.now();
    const allOrgs = await this.orgs.find({ order: { createdAt: 'DESC' } });

    // ── per-org counts (one grouped query each) ──────────────────────────────
    const [
      membersByOrg,
      deptsByOrg,
      policiesByOrg,
      attendanceByOrg,
      onboardingByOrg,
    ] = await Promise.all([
      this.countByOrg(this.memberships, (qb) => qb.andWhere("e.status = 'active'")),
      this.countByOrg(this.departments),
      this.countByOrg(this.policies, (qb) => qb.andWhere('e.isDeleted = false')),
      this.countByOrg(this.attendance),
      this.countByOrg(this.onboardings, (qb) => qb.andWhere('e.isDeleted = false')),
    ]);

    const perOrg = allOrgs.map((o) => ({
      id: o.id,
      name: o.name,
      slug: o.slug,
      status: o.status,
      consented: !!o.consent,
      members: membersByOrg.get(o.id) || 0,
      departments: deptsByOrg.get(o.id) || 0,
      policies: policiesByOrg.get(o.id) || 0,
      attendanceRecords: attendanceByOrg.get(o.id) || 0,
      onboardings: onboardingByOrg.get(o.id) || 0,
      createdAt: o.createdAt,
    }));

    // ── organizations ────────────────────────────────────────────────────────
    const organizations = {
      total: allOrgs.length,
      active: allOrgs.filter((o) => o.status === 'active').length,
      suspended: allOrgs.filter((o) => o.status === 'suspended').length,
      consented: allOrgs.filter((o) => !!o.consent).length,
      newLast7: allOrgs.filter((o) => now - o.createdAt.getTime() <= 7 * DAY).length,
      newLast30: allOrgs.filter((o) => now - o.createdAt.getTime() <= 30 * DAY).length,
    };

    // ── users ────────────────────────────────────────────────────────────────
    const [userTotal, userActive, platformAdmins] = await Promise.all([
      this.users.count(),
      this.users.count({ where: { isActive: true } }),
      this.users.count({ where: { isPlatformAdmin: true } }),
    ]);

    // ── members (memberships) by role tier + status ──────────────────────────
    const memberRoleRows = await this.memberships
      .createQueryBuilder('m')
      .select('m.role', 'role')
      .addSelect('COUNT(*)', 'count')
      .where("m.status = 'active'")
      .groupBy('m.role')
      .getRawMany<{ role: string; count: string }>();
    const byRole = memberRoleRows
      .map((r) => ({ role: r.role, count: Number(r.count) }))
      .sort((a, b) => b.count - a.count);
    const membersTotal = await this.memberships.count();
    const membersActive = await this.memberships.count({ where: { status: 'active' } });

    // ── feature usage ─────────────────────────────────────────────────────────
    const policyCatRows = await this.policies
      .createQueryBuilder('p')
      .select('p.category', 'category')
      .addSelect('COUNT(*)', 'count')
      .where('p.isDeleted = false')
      .groupBy('p.category')
      .getRawMany<{ category: string; count: string }>();

    const onbStatusRows = await this.onboardings
      .createQueryBuilder('o')
      .select('o.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('o.isDeleted = false')
      .groupBy('o.status')
      .getRawMany<{ status: string; count: string }>();
    const onbBy = (s: string) =>
      Number(onbStatusRows.find((r) => r.status === s)?.count || 0);

    const wfhStatusRows = await this.wfh
      .createQueryBuilder('w')
      .select('w.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('w.isDeleted = false')
      .groupBy('w.status')
      .getRawMany<{ status: string; count: string }>();
    const wfhBy = (s: string) =>
      Number(wfhStatusRows.find((r) => r.status === s)?.count || 0);

    const features = {
      policies: {
        total: await this.policies.count({ where: { isDeleted: false } }),
        active: await this.policies.count({ where: { isDeleted: false, isActive: true } }),
        byCategory: policyCatRows
          .map((r) => ({ category: r.category, count: Number(r.count) }))
          .sort((a, b) => b.count - a.count),
      },
      attendance: {
        records: await this.attendance.count(),
        orgsUsing: attendanceByOrg.size,
      },
      onboarding: {
        total: onbStatusRows.reduce((s, r) => s + Number(r.count), 0),
        pending: onbBy('pending'),
        inProgress: onbBy('in_progress'),
        completed: onbBy('completed'),
      },
      notifications: {
        total: await this.notifications.count(),
        unread: await this.notifications.count({ where: { read: false, isDeleted: false } }),
      },
      wfh: {
        total: wfhStatusRows.reduce((s, r) => s + Number(r.count), 0),
        pending: wfhBy('pending'),
        approved: wfhBy('approved'),
      },
      departments: { total: await this.departments.count() },
    };

    // Engagement: orgs that have any people/attendance/policy activity beyond seed.
    const activeOrgs = perOrg.filter(
      (o) => o.members > 0 || o.attendanceRecords > 0 || o.onboardings > 0,
    ).length;

    return {
      generatedAt: new Date(),
      organizations: { ...organizations, engaged: activeOrgs },
      users: { total: userTotal, active: userActive, platformAdmins },
      members: { total: membersTotal, active: membersActive, byRole },
      features,
      perOrg,
      recentOrgs: perOrg.slice(0, 6),
    };
  }
}
