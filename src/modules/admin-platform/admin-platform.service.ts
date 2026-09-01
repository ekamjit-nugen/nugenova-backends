import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { OrganizationEntity } from '../organization/entities/organization.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { NotificationEntity } from '../notification/entities/notification.entity';
import { SessionEntity } from '../auth/entities/session.entity';
import { EmailOutboxEntity } from '../../bootstrap/mail/email-outbox.entity';

const DAY = 86_400_000;

/**
 * AdminPlatformService — the super admin's PLATFORM operations view.
 *
 * Scope boundary (important): the super admin operates the platform; they are NOT
 * a member of any tenant and must NOT see what happens *inside* an organization.
 * So this service reports only account-, security-, and infrastructure-level
 * signals — organizations, seats, auth/session posture, and mail/notification
 * throughput. It deliberately exposes NO tenant business data (payroll, leave,
 * policies, onboarding, attendance, HR content); those stay private to each org.
 *
 * Every number is a cross-tenant aggregate computed with grouped queries.
 */
@Injectable()
export class AdminPlatformService {
  constructor(
    @InjectRepository(OrganizationEntity)
    private readonly orgs: Repository<OrganizationEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    @InjectRepository(OrgMembershipEntity)
    private readonly memberships: Repository<OrgMembershipEntity>,
    @InjectRepository(NotificationEntity)
    private readonly notifications: Repository<NotificationEntity>,
    @InjectRepository(SessionEntity)
    private readonly sessions: Repository<SessionEntity>,
    @InjectRepository(EmailOutboxEntity)
    private readonly emails: Repository<EmailOutboxEntity>,
  ) {}

  /** COUNT(*) on a repo where createdAt ≥ `since`. */
  private countSince(repo: Repository<any>, since: Date): Promise<number> {
    return repo.createQueryBuilder('e').where('e.createdAt >= :since', { since }).getCount();
  }

  async getUsage() {
    const now = Date.now();
    const nowDate = new Date(now);
    const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);

    const allOrgs = await this.orgs.find({ order: { createdAt: 'DESC' } });

    // ── seats per org (the one account-level usage number we surface) ──────────
    const seatRows = await this.memberships
      .createQueryBuilder('m')
      .select('m.organizationId', 'orgId')
      .addSelect('COUNT(*)', 'count')
      .where("m.status = 'active'")
      .groupBy('m.organizationId')
      .getRawMany<{ orgId: string; count: string }>();
    const seatsByOrg = new Map(seatRows.map((r) => [r.orgId, Number(r.count)]));

    const perOrg = allOrgs.map((o) => ({
      id: o.id,
      name: o.name,
      slug: o.slug,
      status: o.status,
      consented: !!o.consent,
      members: seatsByOrg.get(o.id) || 0, // active seats — a billing/account metric
      createdAt: o.createdAt,
    }));

    // ── organizations (accounts) ───────────────────────────────────────────────
    const organizations = {
      total: allOrgs.length,
      active: allOrgs.filter((o) => o.status === 'active').length,
      suspended: allOrgs.filter((o) => o.status === 'suspended').length,
      consented: allOrgs.filter((o) => !!o.consent).length,
      newLast7: allOrgs.filter((o) => now - o.createdAt.getTime() <= 7 * DAY).length,
      newLast30: allOrgs.filter((o) => now - o.createdAt.getTime() <= 30 * DAY).length,
      engaged: perOrg.filter((o) => o.members > 0).length,
    };

    // ── users + seats ──────────────────────────────────────────────────────────
    const [userTotal, userActive, platformAdmins, membersTotal, membersActive] =
      await Promise.all([
        this.users.count(),
        this.users.count({ where: { isActive: true } }),
        this.users.count({ where: { isPlatformAdmin: true } }),
        this.memberships.count(),
        this.memberships.count({ where: { status: 'active' } }),
      ]);

    // ── communications (infrastructure throughput — no tenant content) ─────────
    const emailStatusRows = await this.emails
      .createQueryBuilder('e')
      .select('e.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('e.status')
      .getRawMany<{ status: string; count: string }>();
    const emailBy = (s: string) => Number(emailStatusRows.find((r) => r.status === s)?.count || 0);
    const emailsSent = emailBy('sent');
    const emailsFailed = emailBy('failed');
    const emailsQueued = emailBy('queued');
    const emailsTotal = emailStatusRows.reduce((s, r) => s + Number(r.count), 0);
    const emailsAttempted = emailsSent + emailsFailed; // 'queued' = outbox driver, not transmitted
    const [emailsLast7, emailsLast30] = await Promise.all([
      this.countSince(this.emails, new Date(now - 7 * DAY)),
      this.countSince(this.emails, new Date(now - 30 * DAY)),
    ]);

    // Notifications: only the AGGREGATE volume (a throughput signal). We do NOT
    // break down by category/type — that would leak which features tenants use.
    const [notifTotal, notifUnread, notifLast7, notifLast30] = await Promise.all([
      this.notifications.count(),
      this.notifications.count({ where: { read: false, isDeleted: false } }),
      this.countSince(this.notifications, new Date(now - 7 * DAY)),
      this.countSince(this.notifications, new Date(now - 30 * DAY)),
    ]);

    const communications = {
      emails: {
        total: emailsTotal,
        sent: emailsSent,
        failed: emailsFailed,
        queued: emailsQueued,
        attempted: emailsAttempted,
        deliveryRate: emailsAttempted ? Math.round((emailsSent / emailsAttempted) * 100) : null,
        last7: emailsLast7,
        last30: emailsLast30,
      },
      notifications: {
        total: notifTotal,
        unread: notifUnread,
        read: notifTotal - notifUnread,
        readRate: notifTotal ? Math.round(((notifTotal - notifUnread) / notifTotal) * 100) : 0,
        last7: notifLast7,
        last30: notifLast30,
      },
    };

    // ── security posture (MFA, verification, sessions, lockouts) ───────────────
    const activeSessionQb = () =>
      this.sessions
        .createQueryBuilder('s')
        .where('s.isRevoked = false')
        .andWhere('s.expiresAt > :now', { now: nowDate });
    const mfaMethodRows = await this.users
      .createQueryBuilder('u')
      .select('u.mfaMethod', 'method')
      .addSelect('COUNT(*)', 'count')
      .where('u.mfaEnabled = true')
      .groupBy('u.mfaMethod')
      .getRawMany<{ method: string | null; count: string }>();
    const [mfaEnabled, emailVerified, everLoggedIn, lockedNow, activeSessions, sessionsTotal] =
      await Promise.all([
        this.users.count({ where: { mfaEnabled: true } }),
        this.users.count({ where: { isEmailVerified: true } }),
        this.users.createQueryBuilder('u').where('u.lastLogin IS NOT NULL').getCount(),
        this.users.createQueryBuilder('u').where('u.lockUntil > :now', { now: nowDate }).getCount(),
        activeSessionQb().getCount(),
        this.sessions.count(),
      ]);
    const uniqueSessionRow = await activeSessionQb()
      .select('COUNT(DISTINCT s.userId)', 'c')
      .getRawOne<{ c: string }>();

    const security = {
      mfaEnabled,
      mfaAdoption: pct(mfaEnabled, userActive),
      mfaByMethod: mfaMethodRows
        .map((r) => ({ method: r.method || 'unknown', count: Number(r.count) }))
        .sort((a, b) => b.count - a.count),
      emailVerified,
      emailVerifiedPct: pct(emailVerified, userTotal),
      everLoggedIn,
      dormant: userTotal - everLoggedIn,
      lockedNow,
      sessions: {
        active: activeSessions,
        uniqueUsers: Number(uniqueSessionRow?.c || 0),
        total: sessionsTotal,
      },
    };

    return {
      generatedAt: new Date(),
      organizations,
      users: {
        total: userTotal,
        active: userActive,
        platformAdmins,
        verified: emailVerified,
        everLoggedIn,
        dormant: userTotal - everLoggedIn,
      },
      members: { total: membersTotal, active: membersActive },
      communications,
      security,
      perOrg,
      recentOrgs: perOrg.slice(0, 6),
    };
  }
}
