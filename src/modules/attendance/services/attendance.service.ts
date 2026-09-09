import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';

import {
  AttendanceEntity,
  WorkSegment,
  GeoLocation,
  GeoCheck,
} from '../entities/attendance.entity';
import { HolidayEntity } from '../entities/holiday.entity';
import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';
import { staffScope } from '../../auth/entities/person-type';
import { UserEntity } from '../../auth/entities/user.entity';
import { LeaveRequestEntity } from '../../leave/entities/leave-request.entity';
import { PolicyService } from '../../policy/policy.service';
import { WfhRequestService } from './wfh-request.service';
import {
  WorkLocationConfig,
  WfhConfig,
  PolicyEntity,
  TIMING_CATEGORIES,
} from '../../policy/entities/policy.entity';
import {
  DEFAULT_TZ,
  dayBoundsUtc,
  dayAnchorUtc,
  dayKeyInTz,
  monthBoundsUtc,
  weekdayNameInTz,
} from '../util/tz-day.util';
import {
  DEFAULT_WORK_TIMING,
  WorkTiming,
  computeShiftStatusFields,
} from '../util/status-compute';
import {
  CheckInDto,
  CheckOutDto,
  ManualEntryDto,
  ApproveEntryDto,
  RequestEditDto,
  ReviewEditDto,
  AttendanceQueryDto,
  CreateHolidayDto,
} from '../dto';

/**
 * The caller's identity, resolved from the JWT by the controller. Passed to
 * every method so scoping + role rules are explicit and testable (no `this`
 * request state).
 */
export interface Caller {
  userId: string;
  orgId: string; // guaranteed non-null by AttendanceAccessGuard
  roles: string[];
  orgRole: string | null;
  perms: Record<string, string[]> | null;
  permScoped: boolean;
  // The department a permScoped custom role is bound to (JWT `departmentScopeId`,
  // from the role's `departmentId`). When set, this caller "leads" only that
  // department: every org-wide read is narrowed to its members and cross-
  // department writes are refused. Owner/admin are never permScoped → never
  // narrowed. Null for org-wide roles.
  departmentScopeId: string | null;
  ip?: string;
}

// Platform roles / org roles that MANAGE attendance and therefore never clock
// their own time (they'd get a Clock-In button + be marked absent daily).
// HR and managers are deliberately NOT excluded — they are ICs who track hours.
const EXCLUDED_TOP_ROLES = ['admin', 'super_admin'];
const EXCLUDED_ORG_ROLES = ['admin', 'owner'];

// Bounds on org-wide reads (the monolith paginated / capped the window; full
// pagination is a Phase-2 item). A wide-open range must never fetch unbounded.
const MAX_LIST_ROWS = 2000;
const MAX_ACTIVITY_DAYS = 92;

// Org tiers with automatic org-wide access. In Nexora the privileged standard
// tiers are owner/admin; HR/manager team access is granted via a custom role
// carrying `attendance:view` (permScoped), NOT the raw tier — this keeps the
// stats self-vs-org branch consistent with the org-endpoint guard, which only
// admits owner/admin or a matrix role. (Legacy used hardcoded @Roles tiers.)
const ORG_VIEW_ROLES = ['owner', 'admin'];

/**
 * AttendanceService — the interactive attendance surface ported from the
 * Nugenova monolith to Postgres/TypeORM.
 *
 * **Org scoping is unconditional here.** The monolith scoped with
 * `if (orgId) filter.organizationId = orgId`, so a JWT with `organizationId:
 * null` (a platform super-admin) dropped the filter and read EVERY org's rows.
 * In this port `orgId` is guaranteed non-null by `AttendanceAccessGuard` and is
 * ALWAYS applied — the null-org cross-tenant leak is closed by construction.
 *
 * Phase 1 covers the clock loop, records, stats, org roster, manual-entry +
 * edit-request review, holidays and the activity feed. The policy/shift engine,
 * geo-fence, WFH caps, crons, alerts and payroll public-api arrive in Phase 2
 * with their dependency modules (see PLAYBOOK.md).
 */
@Injectable()
export class AttendanceService {
  private readonly logger = new Logger(AttendanceService.name);

  constructor(
    @InjectRepository(AttendanceEntity)
    private readonly repo: Repository<AttendanceEntity>,
    @InjectRepository(HolidayEntity)
    private readonly holidays: Repository<HolidayEntity>,
    @InjectRepository(OrgMembershipEntity)
    private readonly memberships: Repository<OrgMembershipEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    @InjectRepository(LeaveRequestEntity)
    private readonly leaves: Repository<LeaveRequestEntity>,
    private readonly policyService: PolicyService,
    private readonly wfhRequests: WfhRequestService,
  ) {}

  // ── tz + policy helpers ─────────────────────────────────────────────────────

  private orgTimezone(): string {
    return process.env.ATTENDANCE_DEFAULT_TZ || DEFAULT_TZ;
  }

  private getTodayDateRange(): { start: Date; end: Date } {
    const { start, end } = dayBoundsUtc(new Date(), this.orgTimezone());
    return { start, end };
  }

  /**
   * Resolve the work context governing an employee's clock-in FROM THE POLICY
   * module — the applicable work-timing policy (specific ▸ department ▸ all),
   * plus its work-location and WFH rules. Attendance sits behind Policy: the
   * "late" line, the geo-fence and the WFH rules all come from the resolved
   * policy. If (unexpectedly) no policy applies, fall back to the safe default so
   * a clock-in is never hard-blocked by a mis-seeded org.
   */
  private async resolveContext(
    userId: string,
    orgId: string,
  ): Promise<{ wt: WorkTiming; workLocation: WorkLocationConfig | null; wfhConfig: WfhConfig | null }> {
    const ctx = await this.policyService.resolveForEmployee(orgId, userId);
    const p = ctx.workTiming;
    const d = DEFAULT_WORK_TIMING;
    const wt: WorkTiming = {
      startTime: p?.startTime ?? d.startTime,
      endTime: p?.endTime ?? d.endTime,
      timezone: p?.timezone ?? d.timezone,
      graceMinutes: p?.graceMinutes ?? d.graceMinutes,
      minWorkingHours: p?.minWorkingHours ?? d.minWorkingHours,
      breakMinutes: p?.breakMinutes ?? d.breakMinutes,
      lateToHalfDayMinutes: p?.lateToHalfDayMinutes ?? d.lateToHalfDayMinutes,
      minHoursForPresent: p?.minHoursForPresent ?? d.minHoursForPresent,
      isNightShift: p?.isNightShift ?? d.isNightShift,
    };
    return { wt, workLocation: ctx.workLocation, wfhConfig: ctx.wfhConfig };
  }

  // ── policy enforcement (WFH allowed-days/cap + office geo-fence) ─────────────

  /** Great-circle distance in km between two lat/long points. */
  private haversineKm(
    a: { latitude: number; longitude: number },
    b: { latitude: number; longitude: number },
  ): number {
    const R = 6371;
    const toRad = (x: number) => (x * Math.PI) / 180;
    const dLat = toRad(b.latitude - a.latitude);
    const dLon = toRad(b.longitude - a.longitude);
    const lat1 = toRad(a.latitude);
    const lat2 = toRad(b.latitude);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /**
   * Enforce the resolved policy's WFH rules at a WFH-declared clock-in:
   * `allowedDays` (weekday must be permitted) + `maxDaysPerMonth` cap.
   * `requiresApproval` is intentionally NOT enforced here (owned by Leave).
   */
  private async enforceWfhPolicy(
    wfh: WfhConfig | null,
    userId: string,
    orgId: string,
    now: Date,
  ): Promise<void> {
    if (!wfh) return;
    const tz = this.orgTimezone();
    const allowed = (wfh.allowedDays || []).map((d) => d.toLowerCase());
    if (allowed.length) {
      const today = weekdayNameInTz(now, tz); // e.g. 'friday'
      const ok = allowed.includes(today) || allowed.includes(today.slice(0, 3));
      if (!ok) {
        throw new BadRequestException(
          `Work-from-home is not permitted on ${today} under your work policy.`,
        );
      }
    }
    const cap = Number(wfh.maxDaysPerMonth) || 0;
    if (cap > 0) {
      const used = await this.countWfhDaysThisMonth(userId, orgId, now);
      if (used >= cap) {
        throw new BadRequestException(
          `You have reached your monthly work-from-home limit (${cap}).`,
        );
      }
    }
  }

  private async countWfhDaysThisMonth(userId: string, orgId: string, at: Date): Promise<number> {
    const { start, end } = monthBoundsUtc(at, this.orgTimezone());
    return this.repo.count({
      where: {
        organizationId: orgId,
        employeeId: userId,
        status: 'wfh',
        isDeleted: false,
        date: Between(start, end),
      },
    });
  }

  /**
   * Enforce the resolved policy's work-location at a normal clock-in and return
   * the geoCheck breadcrumb. home / no-policy → allowed anywhere; office →
   * location required and must be inside a geo-fence (else 400); hybrid →
   * recorded but never blocked.
   */
  private enforceWorkLocation(
    wl: WorkLocationConfig | null,
    location: GeoLocation | null,
  ): GeoCheck {
    const mode = (wl?.mode || 'home') as 'office' | 'home' | 'hybrid';
    if (!wl || mode === 'home') {
      return { mode, verified: null, distanceKm: null, officeName: null };
    }
    const offices = (wl.offices || []).filter(
      (o) => Number.isFinite(o.latitude) && Number.isFinite(o.longitude),
    );
    if (!offices.length) {
      return { mode, verified: false, distanceKm: null, officeName: null };
    }
    if (!location || !Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) {
      if (mode === 'office') {
        throw new BadRequestException(
          'Your work policy requires your location to clock in from the office.',
        );
      }
      return { mode, verified: false, distanceKm: null, officeName: null };
    }
    const defaultRadius = Number.isFinite(wl.geoFenceRadiusKm)
      ? (wl.geoFenceRadiusKm as number)
      : 2;
    let nearest = Infinity;
    let nearestOffice: WorkLocationConfig['offices'] extends (infer O)[] ? O : any = null;
    let nearestRadius = defaultRadius;
    for (const o of offices) {
      const dist = this.haversineKm(location, o);
      if (dist < nearest) {
        nearest = dist;
        nearestOffice = o;
        nearestRadius = Number.isFinite(o.radiusKm) ? (o.radiusKm as number) : defaultRadius;
      }
    }
    const within = nearest <= nearestRadius;
    if (mode === 'office' && !within) {
      throw new BadRequestException(
        'You are outside the office geo-fence — clock-in is only allowed from the office.',
      );
    }
    return {
      mode,
      verified: within,
      distanceKm: parseFloat(nearest.toFixed(3)),
      officeName: nearestOffice?.name || null,
    };
  }

  // ── role rules ──────────────────────────────────────────────────────────────

  /** Block admins/owners from clocking their own time (they manage, not track). */
  private validateNotAdmin(roles: string[], orgRole: string | null): void {
    const topExcluded = (roles || []).some((r) => EXCLUDED_TOP_ROLES.includes(r));
    const orgExcluded = orgRole ? EXCLUDED_ORG_ROLES.includes(orgRole) : false;
    if (topExcluded || orgExcluded) {
      throw new ForbiddenException(
        'Administrators and owners manage attendance and do not clock their own time.',
      );
    }
  }

  /** Whether the caller may see org-wide (vs self-only) attendance. */
  canViewOrgAttendance(c: Caller): boolean {
    if (c.orgRole && ORG_VIEW_ROLES.includes(c.orgRole)) return true;
    // A permScoped custom role that was granted attendance:view.
    const actions = c.perms?.['attendance'];
    return Array.isArray(actions) && actions.includes('view');
  }

  /** Whether the caller may WRITE org-wide attendance (approve, edit others). */
  private canEditOrgAttendance(c: Caller): boolean {
    if (c.orgRole === 'owner' || c.orgRole === 'admin') return true;
    const actions = c.perms?.['attendance'];
    return Array.isArray(actions) && actions.includes('edit');
  }

  // ── department scoping ("a manager leads their own team") ────────────────────

  /**
   * The set of employee (user) ids a department-scoped caller may see/act on, or
   * `null` when the caller is not department-scoped (→ whole org, no narrowing).
   *
   * A permScoped custom role bound to a department (JWT `departmentScopeId`) sees
   * ONLY that department's active members — the concrete meaning of "the manager
   * leads their team." Owner/admin (perms=null, permScoped=false) are never
   * narrowed. The caller is always included so a lead never loses their own row,
   * even if they sit in no department. Cached per call via the `_scope` memo the
   * callers pass through to avoid re-querying memberships within one request.
   */
  private async departmentScopeIds(c: Caller): Promise<Set<string> | null> {
    if (!c.permScoped || !c.departmentScopeId) return null;
    // staffScope: a department-scoped lead's attendance surface is their STAFF
    // team — never students who may later share the department.
    const members = await this.memberships.find({
      where: staffScope({
        organizationId: c.orgId,
        departmentId: c.departmentScopeId,
        status: 'active',
      }),
    });
    const ids = new Set(
      members.map((m) => m.userId).filter(Boolean) as string[],
    );
    ids.add(c.userId); // a lead always sees themselves
    return ids;
  }

  /**
   * Guard a write (approve / review / manual-entry-on-behalf) against the
   * caller's department scope: a department-scoped lead may only touch rows of
   * employees in their own department. A no-op for owner/admin/org-wide roles.
   */
  private async assertInDepartmentScope(
    c: Caller,
    employeeId: string,
  ): Promise<void> {
    const scope = await this.departmentScopeIds(c);
    if (scope && !scope.has(employeeId)) {
      throw new ForbiddenException(
        'That employee is outside the department you manage.',
      );
    }
  }

  // ── segment helpers ─────────────────────────────────────────────────────────

  private findOpenSegment(record: AttendanceEntity): WorkSegment | undefined {
    return (record.workSegments || []).find((s) => !s.checkOutTime);
  }

  /**
   * Recompute worked/effective/overtime hours + re-classify status for a record
   * whose in/out are set. Sum of CLOSED segments (falls back to top-level delta
   * for segment-less manual/edited rows); effective = worked − unpaid break;
   * overtime beyond standard hours. Preserves a non-clock day type (wfh/comp_off).
   */
  private async recomputeWorkedFields(record: AttendanceEntity): Promise<void> {
    const closed = (record.workSegments || []).filter(
      (s) => s.checkInTime && s.checkOutTime,
    );
    let totalWorkingHours: number;
    if (closed.length > 0) {
      const ms = closed.reduce(
        (sum, s) =>
          sum +
          (new Date(s.checkOutTime as string).getTime() -
            new Date(s.checkInTime).getTime()),
        0,
      );
      totalWorkingHours = parseFloat((ms / 3_600_000).toFixed(2));
      record.checkInTime = new Date(record.workSegments[0].checkInTime);
      record.checkOutTime = new Date(closed[closed.length - 1].checkOutTime as string);
    } else {
      const diffMs =
        new Date(record.checkOutTime as Date).getTime() -
        new Date(record.checkInTime as Date).getTime();
      totalWorkingHours = parseFloat((diffMs / 3_600_000).toFixed(2));
    }
    record.totalWorkingHours = totalWorkingHours;

    const { wt } = await this.resolveContext(
      record.employeeId,
      record.organizationId as string,
    );
    const breakHours = (wt.breakMinutes || 0) / 60;
    const standardHours = wt.minWorkingHours > 0 ? wt.minWorkingHours : 8;
    const effective = parseFloat(Math.max(totalWorkingHours - breakHours, 0).toFixed(2));
    record.effectiveWorkingHours = effective;
    record.overtimeHours = parseFloat(Math.max(effective - standardHours, 0).toFixed(2));

    const fields = computeShiftStatusFields(wt, record.checkInTime as Date, totalWorkingHours);
    const preserved = ['wfh', 'comp_off'];
    if (!preserved.includes(record.status)) record.status = fields.status;
    record.isLateArrival = fields.isLateArrival;
    record.lateByMinutes = fields.lateByMinutes;
    record.isEarlyDeparture = fields.isEarlyDeparture;
    record.earlyByMinutes = fields.earlyByMinutes;
    record.isNightShift = fields.isNightShift;
  }

  private isUniqueViolation(err: any): boolean {
    return err?.code === '23505' || err?.driverError?.code === '23505';
  }

  // ── clock-in / clock-out ────────────────────────────────────────────────────

  /** Today's live (non-manual) record for this employee, if any. */
  private async findTodayRecord(
    orgId: string,
    userId: string,
    start: Date,
    end: Date,
  ): Promise<AttendanceEntity | null> {
    const rows = await this.repo.find({
      where: {
        organizationId: orgId,
        employeeId: userId,
        date: Between(start, end),
        isDeleted: false,
      },
      order: { date: 'ASC' },
    });
    // Prefer a live clock (`system`) record to append to, but fall back to ANY
    // record for the day — including an approved manual entry — so a clock-in
    // never creates a SECOND row for a date that already has attendance. (The
    // overlap guard in checkIn then rejects a clock-in inside that day's hours.)
    return rows.find((r) => r.entryType !== 'manual') || rows[0] || null;
  }

  async checkIn(c: Caller, dto: CheckInDto): Promise<AttendanceEntity> {
    this.validateNotAdmin(c.roles, c.orgRole);

    const { start } = this.getTodayDateRange();
    const { end } = this.getTodayDateRange();
    const now = new Date();
    const location = (dto.location as GeoLocation) || null;
    const ip = c.ip || null;
    const method = dto.method || 'web';

    // WFH is no longer self-declared: it counts as work-from-home only when the
    // employee has an APPROVED WFH request covering today (owner/HR-gated). An
    // approved WFH day skips the office geo-fence; every other clock-in is checked
    // against the resolved policy's work-location.
    const dayKey = dayKeyInTz(now, this.orgTimezone());
    const isWfh = await this.wfhRequests.hasApprovedForDay(c.orgId, c.userId, dayKey);
    const { wt, workLocation } = await this.resolveContext(c.userId, c.orgId);
    let geoCheck: GeoCheck;
    if (isWfh) {
      geoCheck = { mode: 'home', verified: null, distanceKm: null, officeName: null };
    } else {
      geoCheck = this.enforceWorkLocation(workLocation, location);
    }

    const record = await this.findTodayRecord(c.orgId, c.userId, start, end);

    if (record) {
      if (this.findOpenSegment(record)) {
        throw new ConflictException(
          'You are already clocked in. Please clock out first.',
        );
      }
      // A new session must start AFTER every earlier session that day ended — you
      // can't clock in for a time already covered by a completed session (e.g. a
      // 09:00–18:00 day already recorded, then a 16:06 clock-in).
      const priorOuts = [
        ...(record.workSegments || []).map((s) => (s.checkOutTime ? new Date(s.checkOutTime).getTime() : 0)),
        record.checkOutTime ? new Date(record.checkOutTime).getTime() : 0,
      ];
      const latestOut = Math.max(0, ...priorOuts);
      if (latestOut && now.getTime() <= latestOut) {
        const until = new Date(latestOut).toLocaleTimeString('en-GB', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: this.orgTimezone(),
        });
        throw new ConflictException(
          `You already have attendance recorded until ${until} today — you can't clock in for an earlier time.`,
        );
      }
      // A manual/imported entry keeps its window in the top-level check-in/out
      // (no segments) — materialise it as a segment so appending a live session
      // doesn't drop its hours on the next recompute.
      const existingSegments =
        record.workSegments && record.workSegments.length
          ? record.workSegments
          : record.checkInTime
            ? [
                {
                  checkInTime: new Date(record.checkInTime).toISOString(),
                  checkOutTime: record.checkOutTime ? new Date(record.checkOutTime).toISOString() : null,
                },
              ]
            : [];
      // Reopen the existing day record with a fresh session segment.
      record.workSegments = [
        ...existingSegments,
        {
          checkInTime: now.toISOString(),
          checkOutTime: null,
          checkInIP: ip,
          checkInLocation: location,
        },
      ];
      if (!record.checkInLocation && location) record.checkInLocation = location;
      record.checkOutTime = null;
      record.checkOutIP = null;
      record.checkOutLocation = null;
      record.geoCheck = geoCheck;
      const saved = await this.repo.save(record);
      this.logger.log(
        `Re-clock-in (segment ${saved.workSegments.length}) for ${c.userId} on ${dayKeyInTz(now, this.orgTimezone())}`,
      );
      return saved;
    }

    // First clock-in of the day → half_day can't be decided yet (no hours), so
    // clock-in only sets present/late; clock-out may demote to half_day. A WFH
    // clock-in is recorded as `wfh` and skips late classification.
    const fields = computeShiftStatusFields(wt, now);

    const entity = this.repo.create({
      organizationId: c.orgId,
      employeeId: c.userId,
      date: start,
      checkInTime: now,
      checkInIP: ip,
      checkInLocation: location,
      entryType: 'system',
      status: isWfh ? 'wfh' : fields.status,
      isLateArrival: isWfh ? false : fields.isLateArrival,
      lateByMinutes: isWfh ? 0 : fields.lateByMinutes,
      isNightShift: fields.isNightShift,
      geoCheck,
      workSegments: [
        {
          checkInTime: now.toISOString(),
          checkOutTime: null,
          checkInIP: ip,
          checkInLocation: location,
        },
      ],
      createdBy: c.userId,
    });

    try {
      return await this.repo.save(entity);
    } catch (err: any) {
      // G-C3: a concurrent clock-in won the unique (org, employee, day) index —
      // return the row that request created instead of erroring out.
      if (this.isUniqueViolation(err)) {
        const existing = await this.findTodayRecord(c.orgId, c.userId, start, end);
        if (existing) {
          this.logger.warn(
            `Concurrent clock-in race for ${c.userId} — returning existing record`,
          );
          return existing;
        }
      }
      throw err;
    }
  }

  async checkOut(c: Caller, dto: CheckOutDto): Promise<AttendanceEntity> {
    this.validateNotAdmin(c.roles, c.orgRole);

    const { start, end } = this.getTodayDateRange();
    const record = await this.findTodayRecord(c.orgId, c.userId, start, end);
    if (!record || !this.findOpenSegment(record)) {
      throw new NotFoundException(
        'No active clock-in found for today. Please clock in first.',
      );
    }

    const now = new Date();
    const location = (dto.location as GeoLocation) || null;
    const ip = c.ip || null;

    const segments = record.workSegments.map((s) => ({ ...s }));
    const openSeg = segments.find((s) => !s.checkOutTime)!;
    openSeg.checkOutTime = now.toISOString();
    openSeg.checkOutIP = ip;
    openSeg.checkOutLocation = location;
    record.workSegments = segments;

    record.checkOutTime = now;
    record.checkOutIP = ip;
    record.checkOutLocation = location;

    await this.recomputeWorkedFields(record);
    const saved = await this.repo.save(record);
    this.logger.log(
      `Check-out for ${c.userId}: ${saved.totalWorkingHours}h across ${saved.workSegments.length} session(s) → status=${saved.status}`,
    );
    return saved;
  }

  /**
   * Auto-close a session that was left open past the end of the day. Closes the
   * open segment (and top-level checkout) at `closeAt`, stamps the record as an
   * auto/missed checkout, recomputes worked hours + status, and saves. Used by
   * the missed-checkout reconcile cron — never by an interactive request.
   */
  async autoCloseStaleSession(record: AttendanceEntity, closeAt: Date): Promise<AttendanceEntity> {
    const segments = (record.workSegments || []).map((s) => ({ ...s }));
    const openSeg = segments.find((s) => !s.checkOutTime);
    if (openSeg) {
      openSeg.checkOutTime = closeAt.toISOString();
      record.workSegments = segments;
    }
    record.checkOutTime = closeAt;
    record.missedCheckout = true;
    record.autoCheckedOut = true;
    record.missedCheckoutAt = new Date();
    await this.recomputeWorkedFields(record);
    return this.repo.save(record);
  }

  // ── read: today / my ────────────────────────────────────────────────────────

  async getTodayStatus(c: Caller) {
    const { start, end } = this.getTodayDateRange();
    // Location is mandatory only under an office work-location policy with at
    // least one geocoded office — surface it so the client captures a fix first.
    const { workLocation } = await this.resolveContext(c.userId, c.orgId);
    const locationRequired =
      workLocation?.mode === 'office' &&
      (workLocation.offices || []).some(
        (o) => Number.isFinite(o.latitude) && Number.isFinite(o.longitude),
      );
    const record = await this.findTodayRecord(c.orgId, c.userId, start, end);
    if (!record) {
      return {
        checkedIn: false,
        checkedOut: false,
        hasOpenSession: false,
        record: null,
        totalHoursToday: 0,
        sessionCount: 0,
        sessions: [],
        firstClockIn: null,
        locationRequired,
      };
    }
    const open = this.findOpenSegment(record);
    const closed = (record.workSegments || []).filter((s) => s.checkOutTime);
    const completedMs = closed.reduce(
      (sum, s) =>
        sum +
        (new Date(s.checkOutTime as string).getTime() -
          new Date(s.checkInTime).getTime()),
      0,
    );
    return {
      checkedIn: true,
      checkedOut: !open,
      hasOpenSession: !!open,
      record,
      totalHoursToday: parseFloat((completedMs / 3_600_000).toFixed(2)),
      sessionCount: (record.workSegments || []).length,
      sessions: record.workSegments || [],
      firstClockIn: record.checkInTime,
      locationRequired,
    };
  }

  async getMyAttendance(c: Caller, startDate?: string, endDate?: string) {
    const where: any = { organizationId: c.orgId, employeeId: c.userId, isDeleted: false };
    if (startDate && endDate) {
      where.date = Between(new Date(startDate), new Date(endDate));
    }
    const rows = await this.repo.find({ where, order: { date: 'DESC' } });
    const named = await this.attachEmployeeNames(rows);
    return this.attachPolicyWindow(c.orgId, named);
  }

  // ── read: org-wide list + stats ─────────────────────────────────────────────

  async getAllAttendance(c: Caller, q: AttendanceQueryDto) {
    const where: any = { organizationId: c.orgId, isDeleted: false };
    if (q.status) where.status = q.status;
    if (q.startDate && q.endDate) {
      where.date = Between(new Date(q.startDate), new Date(q.endDate));
    }
    // Narrow to the caller's department when they are department-scoped, at the
    // query level so a wide window can't leak other departments past the row cap.
    const scope = await this.departmentScopeIds(c);
    if (scope) where.employeeId = In([...scope]);
    // Bound the result set — an org roster over a wide window is unbounded
    // otherwise (the monolith paginated; full pagination lands in Phase 2).
    let rows = await this.repo.find({
      where,
      order: { date: 'DESC' },
      take: MAX_LIST_ROWS,
    });
    rows = await this.filterByDepartment(rows, c.orgId, q.departmentId);
    // Owners aren't part of the tracked attendance list.
    const ownerIds = new Set(
      (await this.memberships.find({ where: { organizationId: c.orgId, role: 'owner' } }))
        .map((m) => m.userId)
        .filter(Boolean) as string[],
    );
    if (ownerIds.size) rows = rows.filter((r) => !ownerIds.has(r.employeeId));
    const named = await this.attachEmployeeNames(rows);
    const filtered = q.search
      ? named.filter((r: any) => {
          const s = q.search!.toLowerCase();
          return (
            (r.employeeName || '').toLowerCase().includes(s) ||
            (r.employeeEmail || '').toLowerCase().includes(s)
          );
        })
      : named;
    return this.attachPolicyWindow(c.orgId, filtered);
  }

  async getStats(c: Caller, startDate?: string, endDate?: string, scopeToSelf = false) {
    // Self view wins; otherwise a department-scoped lead's org numbers cover only
    // their team. `In([...])` for the department, a single id for self.
    const scope = scopeToSelf ? null : await this.departmentScopeIds(c);
    const employeeFilter = scopeToSelf
      ? c.userId
      : scope
        ? In([...scope])
        : undefined;

    const base: any = { organizationId: c.orgId, isDeleted: false };
    if (employeeFilter !== undefined) base.employeeId = employeeFilter;
    if (startDate && endDate) {
      base.date = Between(new Date(startDate), new Date(endDate));
    }
    const count = (extra: any) => this.repo.count({ where: { ...base, ...extra } });

    const pendingBase: any = { organizationId: c.orgId, isDeleted: false };
    if (employeeFilter !== undefined) pendingBase.employeeId = employeeFilter;

    const [present, late, absent, halfDay, wfh, leave, total, pendingManual] =
      await Promise.all([
        count({ status: 'present' }),
        count({ status: 'late' }),
        count({ status: 'absent' }),
        count({ status: 'half_day' }),
        count({ status: 'wfh' }),
        count({ status: 'leave' }),
        count({}),
        this.repo.count({
          where: { ...pendingBase, entryType: 'manual', approvalStatus: 'pending' },
        }),
      ]);
    // Edit-requests live in a jsonb column; count them with a raw predicate,
    // narrowed the same way as the counts above (self ▸ department ▸ org-wide).
    const pendingEditsQb = this.repo
      .createQueryBuilder('a')
      .where('a.organization_id = :orgId', { orgId: c.orgId })
      .andWhere('a.is_deleted = false')
      .andWhere(`a.pending_edit ->> 'status' = 'pending'`);
    if (scopeToSelf) {
      pendingEditsQb.andWhere('a.employee_id = :uid', { uid: c.userId });
    } else if (scope) {
      pendingEditsQb.andWhere('a.employee_id IN (:...scopeIds)', {
        scopeIds: [...scope],
      });
    }
    const pendingEdits = await pendingEditsQb.getCount();

    return {
      total,
      present,
      late,
      absent,
      halfDay,
      wfh,
      leave,
      pendingApprovals: pendingManual + pendingEdits,
    };
  }

  /**
   * Per-employee day summary for a date range — what PAYROLL consumes for LOP.
   * `workingDays` = weekdays minus org holidays in the range; `presentDays` counts
   * present/late/wfh (worked), `halfDays` the half-day records. Leave days are NOT
   * here (payroll gets those from the leave module — no double counting).
   */
  async getDaysSummary(
    orgId: string,
    userId: string,
    start: Date,
    end: Date,
  ): Promise<{ workingDays: number; presentDays: number; halfDays: number }> {
    if (end.getTime() < start.getTime()) {
      return { workingDays: 0, presentDays: 0, halfDays: 0 };
    }
    const rows = await this.repo.find({
      where: { organizationId: orgId, employeeId: userId, date: Between(start, end) },
    });
    let presentDays = 0;
    let halfDays = 0;
    for (const r of rows) {
      if (r.status === 'half_day') halfDays += 1;
      else if (r.status === 'present' || r.status === 'late' || r.status === 'wfh') presentDays += 1;
    }
    const hols = await this.holidays.find({
      where: { organizationId: orgId, isDeleted: false, date: Between(start, end) },
    });
    const holKeys = new Set(hols.map((h) => h.date.toISOString().slice(0, 10)));
    const s = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
    let workingDays = 0;
    for (let t = s.getTime(); t <= end.getTime(); t += 24 * 60 * 60 * 1000) {
      const d = new Date(t);
      const dow = d.getUTCDay();
      if (dow === 0 || dow === 6) continue;
      if (holKeys.has(d.toISOString().slice(0, 10))) continue;
      workingDays += 1;
    }
    return { workingDays, presentDays, halfDays };
  }

  /**
   * Worked hours per calendar day (YYYY-MM-DD → hours) from the employee's
   * attendance records in a range. Used to pre-fill timesheets. Prefers the
   * effective working hours, falling back to total, else 0.
   */
  async hoursByDay(orgId: string, userId: string, start: Date, end: Date): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (end.getTime() < start.getTime()) return out;
    const rows = await this.repo.find({
      where: { organizationId: orgId, employeeId: userId, date: Between(start, end) },
    });
    for (const r of rows) {
      // A manual entry is worked time only once it's approved — a pending or
      // rejected backfill must not inflate the timesheet. Real clock-ins carry
      // no approvalStatus (null) and always count.
      if (this.isUnapprovedManual(r)) continue;
      const key = r.date.toISOString().slice(0, 10);
      const hours = r.effectiveWorkingHours ?? r.totalWorkingHours ?? 0;
      out.set(key, Math.round((Number(hours) || 0) * 100) / 100);
    }
    return out;
  }

  /** A manual/backfilled entry that hasn't been approved yet (pending or rejected). */
  private isUnapprovedManual(r: AttendanceEntity): boolean {
    return r.approvalStatus === 'pending' || r.approvalStatus === 'rejected';
  }

  /**
   * The raw clock trail per calendar day in a range — the actual check-in/out
   * segments behind a timesheet, so an approver can see the underlying logs.
   */
  async logsByDay(
    orgId: string,
    userId: string,
    start: Date,
    end: Date,
  ): Promise<
    Array<{
      date: string;
      segments: Array<{ in: string | null; out: string | null }>;
      firstIn: string | null;
      lastOut: string | null;
      clockedHours: number;
      approvalStatus: 'pending' | 'approved' | 'rejected' | null;
      entryType: string;
      // Whether this day is counted toward the timesheet (an approved manual
      // entry or an ordinary clock-in) — false for a pending/rejected backfill.
      counted: boolean;
    }>
  > {
    if (end.getTime() < start.getTime()) return [];
    // Every day is returned — including days still pending approval — so the
    // approver can see which logs are approved and which are not. Only the
    // `counted` flag (and hoursByDay) reflect what actually reaches the total.
    const rows = await this.repo.find({
      where: { organizationId: orgId, employeeId: userId, date: Between(start, end) },
      order: { date: 'ASC' },
    });
    return rows.map((r) => {
      let segs = (r.workSegments || []).map((s) => ({
        in: s.checkInTime ? new Date(s.checkInTime).toISOString() : null,
        out: s.checkOutTime ? new Date(s.checkOutTime).toISOString() : null,
      }));
      const firstIn = r.checkInTime ? new Date(r.checkInTime).toISOString() : segs[0]?.in ?? null;
      const lastOut = r.checkOutTime ? new Date(r.checkOutTime).toISOString() : segs[segs.length - 1]?.out ?? null;
      // Manual/imported entries have no per-session segments — synthesise one
      // from the record's own check-in/out so the trail is never blank.
      if (segs.length === 0 && (firstIn || lastOut)) segs = [{ in: firstIn, out: lastOut }];
      const hours = r.effectiveWorkingHours ?? r.totalWorkingHours ?? 0;
      return {
        date: r.date.toISOString().slice(0, 10),
        segments: segs,
        firstIn,
        lastOut,
        clockedHours: Math.round((Number(hours) || 0) * 100) / 100,
        approvalStatus: (r.approvalStatus as 'pending' | 'approved' | 'rejected' | null) ?? null,
        entryType: r.entryType,
        counted: !this.isUnapprovedManual(r),
      };
    });
  }

  // ── manual entry + approval ─────────────────────────────────────────────────

  async createManualEntry(c: Caller, dto: ManualEntryDto): Promise<AttendanceEntity> {
    // A manual entry is self-service: a plain member may only file one for
    // THEMSELVES. Filing on behalf of another employee is an org-write and
    // requires attendance:edit (owner/admin or a matrix role) — otherwise any
    // member could inject pending records attributed to (or invent) any userId.
    let employeeId = c.userId;
    if (dto.employeeId && dto.employeeId !== c.userId) {
      if (!this.canEditOrgAttendance(c)) {
        throw new ForbiddenException(
          'You can only submit a manual entry for yourself.',
        );
      }
      // The target must be a real member of this org (no forging unknown ids).
      const member = await this.memberships.findOne({
        where: { organizationId: c.orgId, userId: dto.employeeId },
      });
      if (!member) {
        throw new NotFoundException('That employee is not a member of this organization.');
      }
      // …and inside the department a scoped lead manages.
      await this.assertInDepartmentScope(c, dto.employeeId);
      employeeId = dto.employeeId;
    }
    const dayAnchor = dayAnchorUtc(new Date(dto.date), this.orgTimezone());

    // A live/manual row for that day blocks a manual entry; a system-generated
    // absence is superseded (soft-deleted) so the correction can stand.
    const sameDay = await this.repo.find({
      where: {
        organizationId: c.orgId,
        employeeId,
        date: dayAnchor,
        isDeleted: false,
      },
    });
    for (const row of sameDay) {
      if (row.entryType === 'system' && row.status === 'absent') {
        row.isDeleted = true;
        await this.repo.save(row);
        continue;
      }
      throw new ConflictException(
        'An attendance record already exists for this date.',
      );
    }

    const checkIn = new Date(dto.checkInTime);
    const checkOut = new Date(dto.checkOutTime);
    if (checkOut.getTime() <= checkIn.getTime()) {
      throw new BadRequestException('Clock-out must be after clock-in.');
    }
    const total = parseFloat(
      ((checkOut.getTime() - checkIn.getTime()) / 3_600_000).toFixed(2),
    );
    const effective = parseFloat(Math.max(total - 1, 0).toFixed(2));

    const entity = this.repo.create({
      organizationId: c.orgId,
      employeeId,
      date: dayAnchor,
      checkInTime: checkIn,
      checkOutTime: checkOut,
      totalWorkingHours: total,
      effectiveWorkingHours: effective,
      overtimeHours: parseFloat(Math.max(effective - 8, 0).toFixed(2)),
      status: 'present',
      entryType: 'manual',
      approvalStatus: 'pending',
      notes: dto.reason,
      createdBy: c.userId,
      workSegments: [],
    });
    return this.repo.save(entity);
  }

  async getPendingApprovals(c: Caller) {
    const scope = await this.departmentScopeIds(c);
    const scopeIds = scope ? [...scope] : null;

    const manualWhere: any = {
      organizationId: c.orgId,
      entryType: 'manual',
      approvalStatus: 'pending',
      isDeleted: false,
    };
    if (scopeIds) manualWhere.employeeId = In(scopeIds);
    const manual = await this.repo.find({
      where: manualWhere,
      order: { date: 'DESC' },
    });
    const editsQb = this.repo
      .createQueryBuilder('a')
      .where('a.organization_id = :orgId', { orgId: c.orgId })
      .andWhere('a.is_deleted = false')
      .andWhere(`a.pending_edit ->> 'status' = 'pending'`);
    if (scopeIds) editsQb.andWhere('a.employee_id IN (:...scopeIds)', { scopeIds });
    const edits = await editsQb.orderBy('a.date', 'DESC').getMany();

    const manualNamed = (await this.attachEmployeeNames(manual)).map((r: any) => ({
      ...r,
      approvalKind: 'manual',
    }));
    const editNamed = (await this.attachEmployeeNames(edits)).map((r: any) => ({
      ...r,
      approvalKind: 'edit',
    }));
    return [...manualNamed, ...editNamed];
  }

  private async assertNotSelfApproval(c: Caller, row: AttendanceEntity): Promise<void> {
    const privileged =
      (c.orgRole && ['owner', 'admin'].includes(c.orgRole)) ||
      (c.roles || []).some((r) => ['admin', 'super_admin'].includes(r));
    if (row.employeeId === c.userId && !privileged) {
      throw new ForbiddenException('You cannot approve your own attendance entry.');
    }
  }

  async approveManualEntry(c: Caller, id: string, dto: ApproveEntryDto) {
    const row = await this.repo.findOne({
      where: { id, organizationId: c.orgId, isDeleted: false },
    });
    if (!row || row.entryType !== 'manual') {
      throw new NotFoundException('Manual entry not found.');
    }
    if (row.approvalStatus !== 'pending') {
      throw new ConflictException('This entry has already been reviewed.');
    }
    await this.assertInDepartmentScope(c, row.employeeId);
    await this.assertNotSelfApproval(c, row);
    row.approvalStatus = dto.approved ? 'approved' : 'rejected';
    row.approvedBy = c.userId;
    row.approvedAt = new Date();
    if (!dto.approved) row.rejectionReason = dto.rejectionReason || 'Rejected';
    return this.repo.save(row);
  }

  // ── edit-request workflow ───────────────────────────────────────────────────

  async requestAttendanceEdit(c: Caller, id: string, dto: RequestEditDto) {
    const row = await this.repo.findOne({
      where: { id, organizationId: c.orgId, isDeleted: false },
    });
    if (!row) throw new NotFoundException('Attendance record not found.');
    if (row.employeeId !== c.userId) {
      throw new ForbiddenException('You can only request edits on your own record.');
    }
    row.pendingEdit = {
      proposedCheckInTime: dto.checkInTime || null,
      proposedCheckOutTime: dto.checkOutTime || null,
      reason: dto.reason,
      status: 'pending',
      requestedBy: c.userId,
      requestedAt: new Date().toISOString(),
    };
    return this.repo.save(row);
  }

  async reviewAttendanceEdit(c: Caller, id: string, dto: ReviewEditDto) {
    const row = await this.repo.findOne({
      where: { id, organizationId: c.orgId, isDeleted: false },
    });
    if (!row || !row.pendingEdit || row.pendingEdit.status !== 'pending') {
      throw new NotFoundException('No pending edit request found.');
    }
    await this.assertInDepartmentScope(c, row.employeeId);
    await this.assertNotSelfApproval(c, row);

    const edit = row.pendingEdit;
    if (dto.approved) {
      if (edit.proposedCheckInTime) row.checkInTime = new Date(edit.proposedCheckInTime);
      if (edit.proposedCheckOutTime) row.checkOutTime = new Date(edit.proposedCheckOutTime);
      // Mirror onto the first/last segment then recompute like a fresh clock-out.
      if (row.workSegments?.length) {
        const segs = row.workSegments.map((s) => ({ ...s }));
        if (edit.proposedCheckInTime) segs[0].checkInTime = edit.proposedCheckInTime;
        if (edit.proposedCheckOutTime)
          segs[segs.length - 1].checkOutTime = edit.proposedCheckOutTime;
        row.workSegments = segs;
      }
      if (row.checkInTime && row.checkOutTime) await this.recomputeWorkedFields(row);
      edit.status = 'approved';
    } else {
      edit.status = 'rejected';
      edit.rejectionReason = dto.rejectionReason || 'Rejected';
    }
    edit.reviewedBy = c.userId;
    edit.reviewedAt = new Date().toISOString();
    row.pendingEdit = { ...edit };
    return this.repo.save(row);
  }

  // ── holidays ────────────────────────────────────────────────────────────────

  /**
   * A one-shot health check of the org's attendance configuration — what's set
   * up and what still needs a decision — so managers see, on the attendance page
   * itself, whether they must go configure something. Each item carries a status
   * (ok / attention / info) and where to go fix it.
   */
  async getSetupStatus(c: Caller): Promise<{
    items: Array<{
      key: string;
      label: string;
      status: 'ok' | 'attention' | 'info';
      value: string;
      hint: string;
      actionLabel: string;
      actionUrl: string;
    }>;
    okCount: number;
    attentionCount: number;
  }> {
    const orgId = c.orgId;
    const policies: PolicyEntity[] = await this.policyService.list(orgId).catch(() => []);
    const hasCoords = (o: any) => Number.isFinite(o?.latitude) && Number.isFinite(o?.longitude) && (o.latitude !== 0 || o.longitude !== 0);

    // Work schedule (always resolves — the default is seeded per org).
    const timingPolicy = policies.find(
      (p) => TIMING_CATEGORIES.includes(p.category) && p.applicableTo === 'all' && p.workTiming?.startTime,
    );
    const wt = timingPolicy?.workTiming || DEFAULT_WORK_TIMING;
    let hasCustomTiming = false;
    try {
      hasCustomTiming = !!(await this.policyService.getOwnerSummary(orgId))?.hasCustomPolicy;
    } catch {
      /* ignore */
    }

    // Geo-fence: only truly enforced when office mode + at least one geocoded office.
    const officePolicy = policies.find(
      (p) => p.workLocation?.mode === 'office' && (p.workLocation.offices || []).some(hasCoords),
    );
    const officeCount = officePolicy ? (officePolicy.workLocation!.offices || []).filter(hasCoords).length : 0;

    // WFH policy (a configured allowance / allowed days).
    const wfhPolicy = policies.find(
      (p) => p.wfhConfig && ((p.wfhConfig.maxDaysPerMonth || 0) > 0 || (p.wfhConfig.allowedDays || []).length > 0),
    );

    const year = new Date().getFullYear();
    const holidayCount = await this.holidays.count({ where: { organizationId: orgId, isDeleted: false, year } });

    const timesheet = await this.policyService.getTimesheetConfig(orgId).catch(() => null);
    const payroll = await this.policyService.getPayrollConfig(orgId).catch(() => null);

    const items = [
      {
        key: 'schedule',
        label: 'Work schedule',
        status: 'ok' as const,
        value: `${wt.startTime}–${wt.endTime} · ${wt.graceMinutes ?? 15}m grace`,
        hint: hasCustomTiming ? 'A custom work-timing policy is set.' : 'Using the default 9-to-6 schedule — customise it if your hours differ.',
        actionLabel: 'Work timing',
        actionUrl: '/policies',
      },
      {
        key: 'geofence',
        label: 'Location tracking',
        status: 'info' as const,
        value: officePolicy ? `Geo-fenced · ${officeCount} office${officeCount === 1 ? '' : 's'}` : 'Clock-in from anywhere',
        hint: officePolicy
          ? `Clock-in requires being within ${officePolicy.workLocation!.geoFenceRadiusKm ?? 2}km of an office.`
          : 'No office geo-fence — add offices in a policy to require on-site clock-in.',
        actionLabel: 'Work location',
        actionUrl: '/policies',
      },
      {
        key: 'wfh',
        label: 'Work from home',
        status: 'info' as const,
        value: wfhPolicy ? `Up to ${wfhPolicy.wfhConfig!.maxDaysPerMonth || '∞'} days/mo` : 'Not configured',
        hint: wfhPolicy ? 'A WFH allowance is defined.' : 'No WFH allowance set — employees can still raise WFH requests.',
        actionLabel: 'WFH policy',
        actionUrl: '/policies',
      },
      {
        key: 'holidays',
        label: `Holidays (${year})`,
        status: (holidayCount === 0 ? 'attention' : 'ok') as 'ok' | 'attention',
        value: holidayCount === 0 ? 'None added' : `${holidayCount} holiday${holidayCount === 1 ? '' : 's'}`,
        hint: holidayCount === 0 ? `No holidays for ${year} — days off will count as working days.` : 'Holiday calendar is set for this year.',
        actionLabel: 'Add holidays',
        actionUrl: '/attendance',
      },
      {
        key: 'timesheet',
        label: 'Timesheets',
        status: 'info' as const,
        value: timesheet?.enabled ? `Required · ${timesheet.cadence}` : 'Off',
        hint: timesheet?.enabled ? 'Employees submit timesheets for approval.' : 'Employees do not submit timesheets.',
        actionLabel: 'Timesheet policy',
        actionUrl: '/policies',
      },
      {
        key: 'payroll',
        label: 'Attendance → pay',
        status: 'info' as const,
        value: payroll?.lopFromAttendance ? 'Absences dock pay' : 'No pay impact',
        hint: payroll?.lopFromAttendance
          ? 'Unaccounted/absent days are deducted as loss-of-pay in payroll.'
          : 'Attendance does not affect payroll — turn on in Payroll setup to dock absences.',
        actionLabel: 'Payroll setup',
        actionUrl: '/payroll/setup',
      },
    ];

    return {
      items,
      okCount: items.filter((i) => i.status === 'ok').length,
      attentionCount: items.filter((i) => i.status === 'attention').length,
    };
  }

  /**
   * The daily attendance ROSTER — every active member and their status for one
   * day, so a manager sees the WHOLE team, not just those who happened to clock
   * in (the record list hides the rest). Status is the record's status when one
   * exists, else derived: on approved leave, org holiday, week-off, or simply
   * not-clocked-in. Department-scoped leads see only their team.
   */
  async getDailyRoster(
    c: Caller,
    dateStr?: string,
  ): Promise<{
    date: string;
    rows: Array<{
      userId: string;
      name: string;
      email: string | null;
      role: string;
      status: string;
      checkInTime: string | null;
      checkOutTime: string | null;
      totalHours: number | null;
      isLateArrival: boolean;
      lateByMinutes: number;
      missedCheckout: boolean;
    }>;
    summary: { total: number; clockedIn: number; notClockedIn: number; onLeave: number; absent: number };
  }> {
    const tz = this.orgTimezone();
    const ref = dateStr ? new Date(dateStr) : new Date();
    const { start, end, anchor } = dayBoundsUtc(ref, tz, 0);
    const dayKey = anchor.toISOString().slice(0, 10);
    const weekend = anchor.getUTCDay() === 0 || anchor.getUTCDay() === 6;

    // Active roster (department-narrowed for a scoped lead). The org owner is
    // excluded — owners manage attendance, they aren't part of the tracked roster.
    const scope = await this.departmentScopeIds(c);
    const members = (await this.memberships.find({ where: { organizationId: c.orgId, status: 'active' } }))
      .filter((m) => m.userId && m.role !== 'owner' && (!scope || scope.has(m.userId)));
    const ids = members.map((m) => m.userId as string);
    if (!ids.length) {
      return { date: dayKey, rows: [], summary: { total: 0, clockedIn: 0, notClockedIn: 0, onLeave: 0, absent: 0 } };
    }

    const [users, records, holidayCount, leaveRows] = await Promise.all([
      this.users.find({ where: { id: In(ids) } }),
      this.repo.find({ where: { organizationId: c.orgId, employeeId: In(ids), date: Between(start, end), isDeleted: false } }),
      this.holidays.count({ where: { organizationId: c.orgId, isDeleted: false, date: Between(start, end) } }),
      this.leaves.find({
        where: { organizationId: c.orgId, userId: In(ids), status: 'approved', startDate: LessThanOrEqual(end), endDate: MoreThanOrEqual(start) },
      }),
    ]);
    const userById = new Map(users.map((u) => [u.id, u]));
    const recByEmp = new Map(records.map((r) => [r.employeeId, r]));
    const onLeave = new Set(leaveRows.map((l) => l.userId));
    const isHoliday = holidayCount > 0;

    let clockedIn = 0;
    let notClockedIn = 0;
    let onLeaveCount = 0;
    let absentCount = 0;

    const rows = members.map((m) => {
      const uid = m.userId as string;
      const u = userById.get(uid);
      const name = `${u?.firstName ?? ''} ${u?.lastName ?? ''}`.trim() || u?.email || 'Member';
      const rec = recByEmp.get(uid);
      let status: string;
      let checkInTime: string | null = null;
      let checkOutTime: string | null = null;
      let totalHours: number | null = null;
      let isLateArrival = false;
      let lateByMinutes = 0;
      let missedCheckout = false;

      if (rec) {
        status = rec.status;
        checkInTime = rec.checkInTime ? new Date(rec.checkInTime).toISOString() : null;
        checkOutTime = rec.checkOutTime ? new Date(rec.checkOutTime).toISOString() : null;
        totalHours = rec.totalWorkingHours ?? null;
        isLateArrival = !!rec.isLateArrival;
        lateByMinutes = rec.lateByMinutes || 0;
        missedCheckout = !!rec.missedCheckout;
        if (rec.status === 'absent') absentCount++;
        else clockedIn++;
      } else if (onLeave.has(uid)) {
        status = 'leave';
        onLeaveCount++;
      } else if (['owner', 'admin', 'super_admin'].includes((m.role || '').toLowerCase())) {
        // The employer/admins don't clock in — not a gap.
        status = 'not_tracked';
      } else if (isHoliday) {
        status = 'holiday';
      } else if (weekend) {
        status = 'weekoff';
      } else {
        status = 'not_clocked_in';
        notClockedIn++;
      }

      return { userId: uid, name, email: u?.email ?? null, role: m.role, status, checkInTime, checkOutTime, totalHours, isLateArrival, lateByMinutes, missedCheckout };
    });

    // Clocked-in first, then not-clocked-in, then the rest; by name within.
    const rank = (s: string) => (['present', 'late', 'half_day', 'wfh'].includes(s) ? 0 : s === 'not_clocked_in' ? 1 : 2);
    rows.sort((a, b) => rank(a.status) - rank(b.status) || a.name.localeCompare(b.name));

    return {
      date: dayKey,
      rows,
      summary: { total: rows.length, clockedIn, notClockedIn, onLeave: onLeaveCount, absent: absentCount },
    };
  }

  async listHolidays(c: Caller, year?: number): Promise<HolidayEntity[]> {
    const where: any = { organizationId: c.orgId, isDeleted: false };
    if (year) where.year = year;
    return this.holidays.find({ where, order: { date: 'ASC' } });
  }

  async createHoliday(c: Caller, dto: CreateHolidayDto): Promise<HolidayEntity> {
    const date = dayAnchorUtc(new Date(dto.date), this.orgTimezone());
    const year = date.getUTCFullYear();
    const existing = await this.holidays.findOne({
      where: { organizationId: c.orgId, date, isDeleted: false },
    });
    if (existing) {
      throw new ConflictException('A holiday already exists on this date.');
    }
    return this.holidays.save(
      this.holidays.create({
        organizationId: c.orgId,
        date,
        name: dto.name.trim(),
        type: dto.type || 'national',
        description: dto.description ?? null,
        year,
        createdBy: c.userId,
      }),
    );
  }

  async deleteHoliday(c: Caller, id: string): Promise<void> {
    const row = await this.holidays.findOne({
      where: { id, organizationId: c.orgId, isDeleted: false },
    });
    if (!row) throw new NotFoundException('Holiday not found.');
    row.isDeleted = true;
    await this.holidays.save(row);
  }

  // ── activity feed (basic timeline / grouped) ────────────────────────────────

  async getActivityFeed(
    c: Caller,
    opts: {
      view?: 'timeline' | 'grouped' | 'daily';
      startDate?: string;
      endDate?: string;
      employeeId?: string;
    },
  ) {
    const where: any = { organizationId: c.orgId, isDeleted: false };
    if (opts.startDate && opts.endDate) {
      // Clamp the window so a multi-year range can't pull the whole history.
      const start = new Date(opts.startDate);
      let end = new Date(opts.endDate);
      const maxEnd = new Date(start.getTime() + MAX_ACTIVITY_DAYS * 86_400_000);
      if (end.getTime() > maxEnd.getTime()) end = maxEnd;
      where.date = Between(start, end);
    } else {
      const { start, end } = this.getTodayDateRange();
      where.date = Between(start, end);
    }
    // Department-scoped roles are narrowed to their team; a person filter narrows
    // further (and must stay inside the caller's scope).
    const scope = await this.departmentScopeIds(c);
    if (scope) where.employeeId = In([...scope]);
    if (opts.employeeId && (!scope || scope.has(opts.employeeId))) {
      where.employeeId = opts.employeeId;
    }
    const rows = await this.attachEmployeeNames(
      await this.repo.find({ where, order: { date: 'DESC' }, take: MAX_LIST_ROWS }),
    );

    // The clock sessions behind a record: real clock-ins carry per-session
    // `workSegments`; a manual/imported entry has none, so fall back to its own
    // top-level check-in/out. Without this fallback every manual entry — a large
    // share of a backfilled month — would vanish from the activity feed.
    const sessionsOf = (r: any): Array<{ checkInTime: string; checkOutTime?: string | null }> => {
      if (r.workSegments && r.workSegments.length) return r.workSegments;
      if (r.checkInTime) return [{ checkInTime: r.checkInTime, checkOutTime: r.checkOutTime ?? null }];
      return [];
    };

    const events: any[] = [];
    for (const r of rows as any[]) {
      const meta = { entryType: r.entryType, approvalStatus: r.approvalStatus ?? null, status: r.status };
      for (const seg of sessionsOf(r)) {
        events.push({
          employeeId: r.employeeId, employeeName: r.employeeName,
          type: 'clock_in', at: seg.checkInTime, date: r.date, ...meta,
        });
        if (seg.checkOutTime) {
          events.push({
            employeeId: r.employeeId, employeeName: r.employeeName,
            type: 'clock_out', at: seg.checkOutTime, date: r.date, ...meta,
          });
        }
      }
      if (r.status === 'absent') {
        events.push({
          employeeId: r.employeeId, employeeName: r.employeeName,
          type: 'absent', at: r.date, date: r.date, ...meta,
        });
      }
    }
    events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    if (opts.view === 'grouped') {
      const byPerson = new Map<string, any>();
      for (const r of rows as any[]) {
        const g = byPerson.get(r.employeeId) || {
          employeeId: r.employeeId, employeeName: r.employeeName,
          status: r.status, totalHours: 0, days: 0, sessions: [] as any[],
        };
        g.totalHours = Math.round((g.totalHours + (Number(r.totalWorkingHours) || 0)) * 100) / 100;
        g.days += 1;
        g.sessions.push(...sessionsOf(r));
        byPerson.set(r.employeeId, g);
      }
      return { view: 'grouped', data: [...byPerson.values()] };
    }

    if (opts.view === 'daily') {
      // ONE consolidated card per employee per day. A day may span several
      // records (e.g. an approved manual entry plus a live clock-in) or several
      // sessions in one record — all fold into a single row whose sessions the
      // UI draws as bar segments from clock-in to clock-out.
      const byDay = new Map<string, any>();
      for (const r of rows as any[]) {
        const sessions = sessionsOf(r).map((s) => ({
          in: s.checkInTime ? new Date(s.checkInTime).toISOString() : null,
          out: s.checkOutTime ? new Date(s.checkOutTime).toISOString() : null,
        }));
        const dateKey = new Date(r.date).toISOString().slice(0, 10);
        const key = `${r.employeeId}|${dateKey}`;
        const prev = byDay.get(key);
        const merged = prev || {
          employeeId: r.employeeId,
          employeeName: r.employeeName,
          date: r.date,
          sessions: [] as Array<{ in: string | null; out: string | null }>,
          totalHours: 0,
          effectiveHours: 0,
          status: r.status,
          isLateArrival: false,
          lateByMinutes: 0,
          missedCheckout: false,
          autoCheckedOut: false,
          approvalStatus: null as string | null,
          entryType: r.entryType,
          pendingEntryId: null as string | null,
          _hoursOfMain: -1,
        };
        merged.sessions.push(...sessions);
        merged.totalHours += Number(r.totalWorkingHours) || 0;
        merged.effectiveHours += Number(r.effectiveWorkingHours) || 0;
        merged.isLateArrival = merged.isLateArrival || !!r.isLateArrival;
        merged.lateByMinutes = Math.max(merged.lateByMinutes, r.lateByMinutes || 0);
        merged.missedCheckout = merged.missedCheckout || !!r.missedCheckout;
        merged.autoCheckedOut = merged.autoCheckedOut || !!r.autoCheckedOut;
        if (r.approvalStatus === 'pending') {
          merged.approvalStatus = 'pending';
          // Capture the pending MANUAL entry's id so HR can approve/reject it
          // straight from the activity row.
          if (r.entryType === 'manual' && !merged.pendingEntryId) merged.pendingEntryId = r.id;
        } else if (!merged.approvalStatus) merged.approvalStatus = r.approvalStatus ?? null;
        // Headline status comes from the record with the most worked hours
        // (the substantive session), so a 0-hour stub doesn't override a full day.
        const hrs = Number(r.effectiveWorkingHours) || 0;
        if (hrs > merged._hoursOfMain) { merged.status = r.status; merged._hoursOfMain = hrs; }
        if (r.entryType !== 'manual') merged.entryType = r.entryType;
        byDay.set(key, merged);
      }
      // The bar scales to each employee's work-timing policy (e.g. 09:00–18:00) —
      // resolve it once per person so a late clock-in reads correctly against the
      // policy start, not a fixed clock face.
      const hhmmToMin = (s?: string | null): number | null => {
        if (!s || !/^\d{1,2}:\d{2}$/.test(s)) return null;
        const [h, mm] = s.split(':').map(Number);
        return h * 60 + mm;
      };
      const uniqueEmployees = [...new Set([...byDay.values()].map((m) => m.employeeId))];
      const windowByEmp = new Map<string, { startMin: number; endMin: number }>();
      await Promise.all(
        uniqueEmployees.map(async (uid) => {
          let startMin = 540; // 09:00 fallback (DEFAULT_WORK_TIMING)
          let endMin = 1080; // 18:00
          try {
            const { wt } = await this.resolveContext(uid, c.orgId);
            const s = hhmmToMin(wt.startTime);
            const e = hhmmToMin(wt.endTime);
            if (s !== null) startMin = s;
            if (e !== null && e > s!) endMin = e;
          } catch {
            /* fall back to default window */
          }
          windowByEmp.set(uid, { startMin, endMin });
        }),
      );

      const days = [...byDay.values()].map((m) => {
        m.sessions.sort((a: any, b: any) => (a.in || '').localeCompare(b.in || ''));
        const firstIn = m.sessions.find((s: any) => s.in)?.in ?? null;
        const outs = m.sessions.filter((s: any) => s.out).map((s: any) => s.out);
        const openSession = m.sessions.some((s: any) => s.in && !s.out);
        const lastOut = outs.length ? outs[outs.length - 1] : null;
        const win = windowByEmp.get(m.employeeId) || { startMin: 540, endMin: 1080 };
        const { _hoursOfMain, ...rest } = m;
        return {
          ...rest,
          firstIn,
          lastOut,
          openSession,
          missedCheckout: m.missedCheckout || openSession,
          totalHours: Math.round(m.totalHours * 100) / 100,
          effectiveHours: Math.round(m.effectiveHours * 100) / 100,
          policyStartMin: win.startMin,
          policyEndMin: win.endMin,
        };
      });
      // For a SINGLE day, include the whole team — even people who never clocked
      // in — so the view is a roster, not just those with a record. (A multi-day
      // range stays record-based; showing every member × every day is noise.)
      if (opts.startDate && opts.startDate === opts.endDate) {
        const tz = this.orgTimezone();
        const { start, end, anchor } = dayBoundsUtc(new Date(opts.startDate), tz, 0);
        const weekend = anchor.getUTCDay() === 0 || anchor.getUTCDay() === 6;
        const scopeSet = await this.departmentScopeIds(c);
        let roster = (await this.memberships.find({ where: { organizationId: c.orgId, status: 'active' } }))
          .filter((m) => m.userId && (!scopeSet || scopeSet.has(m.userId as string)));
        if (opts.employeeId) roster = roster.filter((m) => m.userId === opts.employeeId);
        const present = new Set(days.map((d) => d.employeeId));
        const missing = roster.filter((m) => !present.has(m.userId as string));
        if (missing.length) {
          const missIds = missing.map((m) => m.userId as string);
          const [users, holidayCount, leaveRows, wins] = await Promise.all([
            this.users.find({ where: { id: In(missIds) } }),
            this.holidays.count({ where: { organizationId: c.orgId, isDeleted: false, date: Between(start, end) } }),
            this.leaves.find({ where: { organizationId: c.orgId, userId: In(missIds), status: 'approved', startDate: LessThanOrEqual(end), endDate: MoreThanOrEqual(start) } }),
            this.resolveWorkWindows(c.orgId, missIds),
          ]);
          const uById = new Map(users.map((u) => [u.id, u]));
          const onLeave = new Set(leaveRows.map((l) => l.userId));
          for (const m of missing) {
            const uid = m.userId as string;
            const u = uById.get(uid);
            const role = (m.role || '').toLowerCase();
            const status = onLeave.has(uid)
              ? 'leave'
              : ['owner', 'admin', 'super_admin'].includes(role)
                ? 'not_tracked'
                : holidayCount > 0
                  ? 'holiday'
                  : weekend
                    ? 'weekoff'
                    : 'not_clocked_in';
            const win = wins.get(uid) || { startMin: 540, endMin: 1080 };
            days.push({
              employeeId: uid,
              employeeName: `${u?.firstName ?? ''} ${u?.lastName ?? ''}`.trim() || u?.email || 'Member',
              date: anchor,
              sessions: [],
              firstIn: null,
              lastOut: null,
              openSession: false,
              missedCheckout: false,
              autoCheckedOut: false,
              totalHours: 0,
              effectiveHours: 0,
              status,
              isLateArrival: false,
              lateByMinutes: 0,
              approvalStatus: null,
              entryType: 'system',
              policyStartMin: win.startMin,
              policyEndMin: win.endMin,
            } as (typeof days)[number]);
          }
        }
      }

      // Worked first, then not-clocked-in, then off-states; newest day, then name.
      const statusRank = (s: string) =>
        ['present', 'late', 'half_day', 'wfh'].includes(s) ? 0 : s === 'not_clocked_in' ? 1 : s === 'absent' ? 2 : 3;
      days.sort(
        (a, b) =>
          String(b.date).localeCompare(String(a.date)) ||
          statusRank(a.status) - statusRank(b.status) ||
          String(a.employeeName || '').localeCompare(String(b.employeeName || '')),
      );
      return { view: 'daily', data: days };
    }

    return { view: 'timeline', data: events };
  }

  // ── name / department joins ─────────────────────────────────────────────────

  /** Attach `employeeName` to rows from the user directory (by auth userId). */
  private async attachEmployeeNames(
    rows: AttendanceEntity[],
  ): Promise<Array<AttendanceEntity & { employeeName: string; employeeEmail: string | null }>> {
    if (!rows.length) return rows as any;
    const ids = [...new Set(rows.map((r) => r.employeeId))];
    const users = await this.users.find({ where: { id: In(ids) } });
    const nameById = new Map(
      users.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim() || u.email]),
    );
    const emailById = new Map(users.map((u) => [u.id, u.email]));
    return rows.map((r) => ({
      ...r,
      employeeName: nameById.get(r.employeeId) || 'Unknown',
      employeeEmail: emailById.get(r.employeeId) ?? null,
    })) as any;
  }

  /**
   * The work-timing policy window (minutes since midnight) per employee — the
   * scale the clock bar draws against. Resolved once per unique employee, with
   * the DEFAULT_WORK_TIMING (09:00–18:00) fallback.
   */
  private async resolveWorkWindows(
    orgId: string,
    userIds: string[],
  ): Promise<Map<string, { startMin: number; endMin: number }>> {
    const hhmm = (s?: string | null): number | null =>
      s && /^\d{1,2}:\d{2}$/.test(s) ? Number(s.split(':')[0]) * 60 + Number(s.split(':')[1]) : null;
    const out = new Map<string, { startMin: number; endMin: number }>();
    await Promise.all(
      [...new Set(userIds)].map(async (uid) => {
        let startMin = 540;
        let endMin = 1080;
        try {
          const { wt } = await this.resolveContext(uid, orgId);
          const s = hhmm(wt.startTime);
          const e = hhmm(wt.endTime);
          if (s !== null) startMin = s;
          if (e !== null && e > s!) endMin = e;
        } catch {
          /* default window */
        }
        out.set(uid, { startMin, endMin });
      }),
    );
    return out;
  }

  /** Attach the resolved policy window to attendance rows (for the bar UI). */
  private async attachPolicyWindow<T extends { employeeId: string }>(
    orgId: string,
    rows: T[],
  ): Promise<Array<T & { policyStartMin: number; policyEndMin: number }>> {
    if (!rows.length) return rows as any;
    const win = await this.resolveWorkWindows(orgId, rows.map((r) => r.employeeId));
    return rows.map((r) => {
      const w = win.get(r.employeeId) || { startMin: 540, endMin: 1080 };
      return { ...r, policyStartMin: w.startMin, policyEndMin: w.endMin };
    }) as any;
  }

  /** Filter rows to employees in a given department (via org membership). */
  private async filterByDepartment(
    rows: AttendanceEntity[],
    orgId: string,
    departmentId?: string,
  ): Promise<AttendanceEntity[]> {
    if (!departmentId || !rows.length) return rows;
    const members = await this.memberships.find({
      where: { organizationId: orgId, departmentId },
    });
    const allow = new Set(members.map((m) => m.userId).filter(Boolean) as string[]);
    return rows.filter((r) => allow.has(r.employeeId));
  }
}
