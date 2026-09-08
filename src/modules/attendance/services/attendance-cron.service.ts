import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, IsNull, LessThanOrEqual, MoreThanOrEqual, Not, Repository } from 'typeorm';

import { AttendanceEntity } from '../entities/attendance.entity';
import { HolidayEntity } from '../entities/holiday.entity';
import { WfhRequestEntity } from '../entities/wfh-request.entity';
import { OrganizationEntity } from '../../organization/entities/organization.entity';
import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';
import { staffScope } from '../../auth/entities/person-type';
import { UserEntity } from '../../auth/entities/user.entity';
import { LeaveRequestEntity } from '../../leave/entities/leave-request.entity';
import { MemberOnboardingEntity } from '../../onboarding/entities/member-onboarding.entity';
import { PolicyService } from '../../policy/policy.service';
import { NotifierService } from '../../notification/notifier.service';
import { MailService } from '../../../bootstrap/mail/mail.service';
import {
  attendanceAbsentEmail,
  attendanceMissedCheckoutEmail,
  attendanceNotClockedInEmail,
  attendanceDigestEmail,
} from '../../../bootstrap/mail/email-layout';
import { AttendanceService } from './attendance.service';
import { DEFAULT_TZ, dayAnchorUtc, dayBoundsUtc } from '../util/tz-day.util';
import { DEFAULT_WORK_TIMING } from '../util/status-compute';

interface Person { name: string; email: string | null }

const HOUR_MS = 3_600_000;
// A session still open this long after its clock-in is treated as a forgotten
// checkout and auto-closed (spans an overnight gap without being punitive).
const STALE_OPEN_HOURS = 18;
// Don't reach back further than this for stale sessions (ancient rows are noise).
const RECONCILE_LOOKBACK_DAYS = 7;
// Roles that never clock in (blocked at check-in) — never absentee-marked/nudged.
const NON_TRACKED_ROLES = new Set(['owner', 'admin', 'super_admin']);

/**
 * AttendanceCronService — the automated operational layer ported from the legacy
 * Nugenova attendance service. Four scheduled jobs, each fanning out across every
 * active organization:
 *
 *  1. reconcileMissedCheckouts (every 3h) — auto-close sessions left open.
 *  2. markAbsentees (daily 08:00) — create an `absent` record for tracked
 *     employees with no record on the previous working day.
 *  3. nudgeMissedClockIns (daily 11:00) — remind employees not yet clocked in.
 *  4. sendDailyExceptionDigest (daily 08:30) — roll up yesterday's exceptions
 *     to org admins.
 *
 * Each `@Cron` entrypoint delegates to a `now`-parameterised core so the logic
 * is deterministically testable. Weekends and org holidays are skipped; approved
 * leave / WFH excludes an employee; the org owner/admins are never tracked.
 * Per-employee escalation targets the reporting manager (when set), so a large
 * roster can't storm every approver.
 */
@Injectable()
export class AttendanceCronService {
  private readonly logger = new Logger(AttendanceCronService.name);

  constructor(
    @InjectRepository(AttendanceEntity) private readonly attendance: Repository<AttendanceEntity>,
    @InjectRepository(HolidayEntity) private readonly holidays: Repository<HolidayEntity>,
    @InjectRepository(WfhRequestEntity) private readonly wfh: Repository<WfhRequestEntity>,
    @InjectRepository(OrganizationEntity) private readonly orgs: Repository<OrganizationEntity>,
    @InjectRepository(OrgMembershipEntity) private readonly memberships: Repository<OrgMembershipEntity>,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(LeaveRequestEntity) private readonly leaves: Repository<LeaveRequestEntity>,
    @InjectRepository(MemberOnboardingEntity) private readonly onboardings: Repository<MemberOnboardingEntity>,
    private readonly policy: PolicyService,
    private readonly notifier: NotifierService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    private readonly attendanceService: AttendanceService,
  ) {}

  // ── cron entrypoints ─────────────────────────────────────────────────────────

  @Cron('0 */3 * * *')
  async cronReconcileMissedCheckouts(): Promise<void> {
    await this.safely('reconcileMissedCheckouts', () => this.reconcileMissedCheckouts(new Date()));
  }

  @Cron('0 8 * * *', { timeZone: DEFAULT_TZ })
  async cronMarkAbsentees(): Promise<void> {
    await this.safely('markAbsentees', () => this.markAbsentees(new Date()));
  }

  @Cron('0 11 * * *', { timeZone: DEFAULT_TZ })
  async cronNudgeMissedClockIns(): Promise<void> {
    await this.safely('nudgeMissedClockIns', () => this.nudgeMissedClockIns(new Date()));
  }

  @Cron('30 8 * * *', { timeZone: DEFAULT_TZ })
  async cronDailyExceptionDigest(): Promise<void> {
    await this.safely('sendDailyExceptionDigest', () => this.sendDailyExceptionDigest(new Date()));
  }

  private async safely(name: string, fn: () => Promise<number>): Promise<void> {
    try {
      const n = await fn();
      this.logger.log(`${name}: ${n} action(s)`);
    } catch (err) {
      this.logger.error(`${name} failed: ${String(err)}`);
    }
  }

  // ── 1. missed-checkout reconcile ──────────────────────────────────────────────

  /** Auto-close every session left open longer than the staleness threshold. */
  async reconcileMissedCheckouts(now: Date, orgId?: string): Promise<number> {
    const cutoff = new Date(now.getTime() - STALE_OPEN_HOURS * HOUR_MS);
    const floor = new Date(now.getTime() - RECONCILE_LOOKBACK_DAYS * 86_400_000);
    const open = await this.attendance.find({
      where: {
        ...(orgId ? { organizationId: orgId } : {}),
        checkInTime: Not(IsNull()),
        checkOutTime: IsNull(),
        isDeleted: false,
        date: Between(floor, now),
      },
    });
    let closed = 0;
    for (const rec of open) {
      const checkIn = rec.checkInTime ? new Date(rec.checkInTime) : null;
      if (!checkIn || checkIn.getTime() > cutoff.getTime()) continue; // still fresh
      const wt = await this.workTiming(rec.organizationId as string, rec.employeeId);
      const span = ((wt.minWorkingHours || 8) + (wt.breakMinutes || 0) / 60) * HOUR_MS;
      const closeAt = new Date(checkIn.getTime() + span);
      try {
        const saved = await this.attendanceService.autoCloseStaleSession(rec, closeAt);
        closed += 1;
        const who = await this.userInfo(saved.employeeId);
        const orgId = saved.organizationId as string;
        const hours = saved.effectiveWorkingHours ?? 0;
        await this.notifier.notify({
          organizationId: orgId,
          userId: saved.employeeId,
          type: 'attendance_missed_checkout',
          title: 'We closed a session you left open',
          body: `You didn't clock out on ${this.dayLabel(saved.date)} — we recorded ${hours}h. Fix it with an edit request if that's wrong.`,
          data: { actionUrl: '/attendance', attendanceId: saved.id },
          priority: 'normal',
        });
        await this.email(
          orgId,
          who.email,
          attendanceMissedCheckoutEmail({
            employeeName: who.name,
            orgName: await this.orgNameFor(orgId),
            dateLabel: this.dayLabel(saved.date),
            hours,
            attendanceUrl: `${this.frontendUrl()}/attendance`,
          }),
          'attendance.missed_checkout',
        );
        await this.escalate(orgId, saved.employeeId, {
          type: 'attendance_missed_checkout',
          title: 'A team member forgot to clock out',
          body: `${who.name} left a session open on ${this.dayLabel(saved.date)} — auto-closed at ${hours}h.`,
          actionUrl: '/attendance',
        });
      } catch (err) {
        this.logger.error(`autoClose failed for record ${rec.id}: ${String(err)}`);
      }
    }
    return closed;
  }

  // ── 2. mark absentees (previous working day) ──────────────────────────────────

  /** Create an `absent` record for tracked employees with no record yesterday. */
  async markAbsentees(now: Date, orgId?: string): Promise<number> {
    let marked = 0;
    for (const org of await this.activeOrgs(orgId)) {
      const tz = this.orgTz(org);
      const anchor = dayAnchorUtc(now, tz, -1); // yesterday, org-local
      if (this.isWeekend(anchor)) continue;
      const { start, end } = dayBoundsUtc(now, tz, -1);
      if (await this.isHoliday(org.id, start, end)) continue;

      for (const m of await this.trackableMembers(org.id)) {
        const uid = m.userId as string;
        if (m.joinedAt && new Date(m.joinedAt).getTime() > end.getTime()) continue; // pre-tracking
        if (await this.hasRecord(org.id, uid, start, end)) continue;
        if (await this.onApprovedLeave(org.id, uid, start, end)) continue;
        if (await this.onApprovedWfh(org.id, uid, start, end)) continue;
        try {
          const row = this.attendance.create({
            organizationId: org.id,
            employeeId: uid,
            date: anchor,
            checkInTime: null,
            checkOutTime: null,
            status: 'absent',
            entryType: 'system',
            workSegments: [],
          });
          await this.attendance.save(row);
          marked += 1;
          const who = await this.userInfo(uid);
          await this.notifier.notify({
            organizationId: org.id,
            userId: uid,
            type: 'attendance_absent',
            title: 'Marked absent',
            body: `You were marked absent for ${this.dayLabel(anchor)} — no attendance was recorded. File a manual entry if this is wrong.`,
            data: { actionUrl: '/attendance', date: this.dayKey(anchor) },
            priority: 'high',
          });
          await this.email(
            org.id,
            who.email,
            attendanceAbsentEmail({
              employeeName: who.name,
              orgName: await this.orgNameFor(org.id),
              dateLabel: this.dayLabel(anchor),
              attendanceUrl: `${this.frontendUrl()}/attendance`,
            }),
            'attendance.absent',
          );
          await this.escalate(org.id, uid, {
            type: 'attendance_absent',
            title: 'A team member was marked absent',
            body: `${who.name} had no attendance on ${this.dayLabel(anchor)} and was marked absent.`,
            actionUrl: '/attendance',
          });
        } catch (err) {
          // Unique (org, employee, date) race — another run created it. Ignore.
          this.logger.warn(`markAbsent skipped for ${uid}@${this.dayKey(anchor)}: ${String(err)}`);
        }
      }
    }
    return marked;
  }

  // ── 3. nudge missed clock-ins (today) ─────────────────────────────────────────

  /** Remind employees who haven't clocked in today; summarise to admins. */
  async nudgeMissedClockIns(now: Date, orgId?: string): Promise<number> {
    let nudged = 0;
    for (const org of await this.activeOrgs(orgId)) {
      const tz = this.orgTz(org);
      const anchor = dayAnchorUtc(now, tz, 0); // today
      if (this.isWeekend(anchor)) continue;
      const { start, end } = dayBoundsUtc(now, tz, 0);
      if (await this.isHoliday(org.id, start, end)) continue;

      const missing: string[] = [];
      for (const m of await this.trackableMembers(org.id)) {
        const uid = m.userId as string;
        if (m.joinedAt && new Date(m.joinedAt).getTime() > end.getTime()) continue;
        if (await this.hasClockIn(org.id, uid, start, end)) continue;
        if (await this.onApprovedLeave(org.id, uid, start, end)) continue;
        if (await this.onApprovedWfh(org.id, uid, start, end)) continue;
        missing.push(uid);
        const who = await this.userInfo(uid);
        await this.notifier.notify({
          organizationId: org.id,
          userId: uid,
          type: 'attendance_not_clocked_in',
          title: "You haven't clocked in yet",
          body: `It's past your start time and we don't have a clock-in from you today. Clock in from the Attendance page.`,
          data: { actionUrl: '/attendance' },
          priority: 'normal',
        });
        await this.email(
          org.id,
          who.email,
          attendanceNotClockedInEmail({
            employeeName: who.name,
            orgName: await this.orgNameFor(org.id),
            attendanceUrl: `${this.frontendUrl()}/attendance`,
          }),
          'attendance.not_clocked_in',
        );
        await this.escalate(org.id, uid, {
          type: 'attendance_not_clocked_in',
          title: 'A team member has not clocked in',
          body: `${who.name} has not clocked in today.`,
          actionUrl: '/attendance',
        });
        nudged += 1;
      }

      // One aggregated summary to org approvers (not one per person).
      if (missing.length) {
        const names = (await Promise.all(missing.slice(0, 5).map((u) => this.userName(u)))).join(', ');
        const more = missing.length > 5 ? ` +${missing.length - 5} more` : '';
        await this.notifier.notifyManagers({
          organizationId: org.id,
          resource: 'attendance',
          action: 'view',
          type: 'attendance_not_clocked_in_summary',
          title: `${missing.length} not clocked in yet`,
          body: `Still to clock in today: ${names}${more}.`,
          data: { actionUrl: '/attendance', count: missing.length },
          priority: 'low',
        });
      }
    }
    return nudged;
  }

  // ── 4. daily exception digest (previous day) ──────────────────────────────────

  /** Roll up yesterday's absent/late/half-day/missed-checkout counts to admins. */
  async sendDailyExceptionDigest(now: Date, orgId?: string): Promise<number> {
    let sent = 0;
    for (const org of await this.activeOrgs(orgId)) {
      const tz = this.orgTz(org);
      const { start, end } = dayBoundsUtc(now, tz, -1);
      const rows = await this.attendance.find({
        where: { organizationId: org.id, isDeleted: false, date: Between(start, end) },
      });
      const absent = rows.filter((r) => r.status === 'absent').length;
      const late = rows.filter((r) => r.isLateArrival).length;
      const halfDay = rows.filter((r) => r.status === 'half_day').length;
      const missed = rows.filter((r) => r.missedCheckout).length;
      const total = absent + late + halfDay + missed;
      if (total === 0) continue;
      const dateLabel = this.dayLabel(dayAnchorUtc(now, tz, -1));
      await this.notifier.notifyManagers({
        organizationId: org.id,
        resource: 'attendance',
        action: 'view',
        type: 'attendance_daily_digest',
        title: `Attendance summary — ${dateLabel}`,
        body: `${absent} absent · ${late} late · ${halfDay} half-day · ${missed} missed checkout.`,
        data: { actionUrl: '/attendance/activity', absent, late, halfDay, missed },
        priority: 'low',
      });
      // Email the same roll-up to each approver.
      const approvers = await this.notifier.resolveManagers(org.id, 'attendance', 'view');
      if (approvers.length) {
        const built = attendanceDigestEmail({
          orgName: await this.orgNameFor(org.id),
          dateLabel,
          absent,
          late,
          halfDay,
          missed,
          activityUrl: `${this.frontendUrl()}/attendance/activity`,
        });
        for (const uid of approvers) {
          const info = await this.userInfo(uid);
          await this.email(org.id, info.email, built, 'attendance.daily_digest');
        }
      }
      sent += 1;
    }
    return sent;
  }

  // ── helpers ───────────────────────────────────────────────────────────────────

  private async activeOrgs(orgId?: string): Promise<OrganizationEntity[]> {
    if (orgId) {
      const org = await this.orgs.findOne({ where: { id: orgId, status: 'active' } });
      return org ? [org] : [];
    }
    return this.orgs.find({ where: { status: 'active' } });
  }

  private orgTz(org: OrganizationEntity): string {
    const tz = (org.settings as { timezone?: string } | null)?.timezone;
    return typeof tz === 'string' && tz ? tz : DEFAULT_TZ;
  }

  /** The anchor is UTC-midnight of the org-local day, so its UTC weekday is that day. */
  private isWeekend(anchor: Date): boolean {
    const dow = anchor.getUTCDay(); // 0=Sun … 6=Sat
    return dow === 0 || dow === 6;
  }

  /** Active STAFF who actually clock time (excludes owner/admin/super-admin). */
  private async trackableMembers(orgId: string): Promise<OrgMembershipEntity[]> {
    // staffScope: the absence/nudge/digest roster tracks STAFF attendance only —
    // students must never land in the staff attendance roster (the same class of
    // defect as the past null-org attendance leak).
    const members = await this.memberships.find({
      where: staffScope({ organizationId: orgId, status: 'active' }),
    });
    return members.filter((m) => m.userId && !NON_TRACKED_ROLES.has((m.role || '').toLowerCase()));
  }

  private async workTiming(orgId: string, userId: string) {
    try {
      const ctx = await this.policy.resolveForEmployee(orgId, userId);
      if (ctx.workTiming) return { ...DEFAULT_WORK_TIMING, ...ctx.workTiming } as typeof DEFAULT_WORK_TIMING;
    } catch {
      /* fall through to default */
    }
    return DEFAULT_WORK_TIMING;
  }

  private async isHoliday(orgId: string, start: Date, end: Date): Promise<boolean> {
    const n = await this.holidays.count({ where: { organizationId: orgId, isDeleted: false, date: Between(start, end) } });
    return n > 0;
  }

  private async hasRecord(orgId: string, userId: string, start: Date, end: Date): Promise<boolean> {
    const n = await this.attendance.count({
      where: { organizationId: orgId, employeeId: userId, isDeleted: false, date: Between(start, end) },
    });
    return n > 0;
  }

  private async hasClockIn(orgId: string, userId: string, start: Date, end: Date): Promise<boolean> {
    const n = await this.attendance.count({
      where: {
        organizationId: orgId,
        employeeId: userId,
        isDeleted: false,
        date: Between(start, end),
        checkInTime: Not(IsNull()),
      },
    });
    return n > 0;
  }

  private async onApprovedLeave(orgId: string, userId: string, start: Date, end: Date): Promise<boolean> {
    const n = await this.leaves.count({
      where: {
        organizationId: orgId,
        userId,
        status: 'approved',
        startDate: LessThanOrEqual(end),
        endDate: MoreThanOrEqual(start),
      },
    });
    return n > 0;
  }

  private async onApprovedWfh(orgId: string, userId: string, start: Date, end: Date): Promise<boolean> {
    const n = await this.wfh.count({
      where: {
        organizationId: orgId,
        userId,
        status: 'approved',
        startDate: LessThanOrEqual(end),
        endDate: MoreThanOrEqual(start),
      },
    });
    return n > 0;
  }

  /** The subject's reporting manager (a userId), from their onboarding record. */
  private async reportingManagerFor(orgId: string, userId: string): Promise<string | null> {
    const row = await this.onboardings.findOne({
      where: { organizationId: orgId, userId, isDeleted: false },
      order: { createdAt: 'DESC' },
    });
    const mgr = row?.reportingManagerId || null;
    return mgr && mgr !== userId ? mgr : null;
  }

  /**
   * Escalate a per-employee exception to their reporting manager (when set). We
   * deliberately do NOT fan out to every approver here — that would storm a large
   * roster; the digest covers org admins instead.
   */
  private async escalate(
    orgId: string,
    subjectUserId: string,
    payload: { type: string; title: string; body: string; actionUrl: string },
  ): Promise<void> {
    const manager = await this.reportingManagerFor(orgId, subjectUserId);
    if (!manager) return;
    await this.notifier.notify({
      organizationId: orgId,
      userId: manager,
      type: payload.type,
      title: payload.title,
      body: payload.body,
      data: { actionUrl: payload.actionUrl, subjectUserId },
      priority: 'normal',
    });
  }

  private async userInfo(userId: string): Promise<Person> {
    const u = await this.users.findOne({ where: { id: userId } });
    if (!u) return { name: 'A team member', email: null };
    return { name: `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email || 'A team member', email: u.email ?? null };
  }

  private async userName(userId: string): Promise<string> {
    return (await this.userInfo(userId)).name;
  }

  private frontendUrl(): string {
    return (this.config.get<string>('FRONTEND_URL') || 'http://localhost:3111').replace(/\/$/, '');
  }

  private async orgNameFor(orgId: string): Promise<string> {
    const org = await this.orgs.findOne({ where: { id: orgId } });
    return org?.name || 'your team';
  }

  /** Best-effort email send — never throws (MailService already swallows). */
  private async email(orgId: string, to: string | null, built: { subject: string; html: string }, category: string): Promise<void> {
    if (!to) return;
    await this.mail.send({ to, subject: built.subject, html: built.html, category, organizationId: orgId });
  }

  private dayKey(anchor: Date): string {
    return anchor.toISOString().slice(0, 10);
  }

  private dayLabel(date: Date): string {
    return new Date(date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
  }
}
