import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { OrganizationEntity } from '../organization/entities/organization.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { applyStaffScope, staffScope } from '../auth/entities/person-type';
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

  /** Rows-per-day since `since` → Map(YYYY-MM-DD → count), for trend sparklines. */
  private async dailyCounts(repo: Repository<any>, since: Date): Promise<Map<string, number>> {
    const rows = await repo
      .createQueryBuilder('e')
      .select("to_char(date_trunc('day', e.created_at), 'YYYY-MM-DD')", 'd')
      .addSelect('COUNT(*)', 'c')
      .where('e.created_at >= :since', { since })
      .groupBy("date_trunc('day', e.created_at)")
      .getRawMany<{ d: string; c: string }>();
    return new Map(rows.map((r) => [r.d, Number(r.c)]));
  }

  async getUsage() {
    const now = Date.now();
    const nowDate = new Date(now);
    const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);

    const allOrgs = await this.orgs.find({ order: { createdAt: 'DESC' } });

    // ── seats per org (the one account-level usage number we surface) ──────────
    // staffScope: seats are a billing/account metric — STAFF only. Counting
    // students/guardians here would inflate every org's seat count.
    const seatRows = await applyStaffScope(
      this.memberships
        .createQueryBuilder('m')
        .select('m.organizationId', 'orgId')
        .addSelect('COUNT(*)', 'count')
        .where("m.status = 'active'"),
      'm',
    )
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
        this.memberships.count({ where: staffScope() }),
        this.memberships.count({ where: staffScope({ status: 'active' }) }),
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

    // ── 30-day daily trends (platform activity — counts only, no tenant content) ─
    const SERIES_DAYS = 30;
    const startDay = new Date(now - (SERIES_DAYS - 1) * DAY);
    startDay.setUTCHours(0, 0, 0, 0);
    const days: string[] = [];
    for (let i = 0; i < SERIES_DAYS; i++) {
      days.push(new Date(startDay.getTime() + i * DAY).toISOString().slice(0, 10));
    }
    const [orgDaily, userDaily, emailDaily, notifDaily, sessDaily] = await Promise.all([
      this.dailyCounts(this.orgs, startDay),
      this.dailyCounts(this.users, startDay),
      this.dailyCounts(this.emails, startDay),
      this.dailyCounts(this.notifications, startDay),
      this.dailyCounts(this.sessions, startDay),
    ]);
    const fill = (m: Map<string, number>) => days.map((d) => m.get(d) || 0);
    const series = {
      days,
      signups: fill(orgDaily),
      users: fill(userDaily),
      emails: fill(emailDaily),
      notifications: fill(notifDaily),
      logins: fill(sessDaily),
    };

    return {
      generatedAt: new Date(),
      organizations,
      series,
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
