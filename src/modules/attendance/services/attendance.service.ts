import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, Repository } from 'typeorm';

import {
  AttendanceEntity,
  WorkSegment,
  GeoLocation,
  GeoCheck,
} from '../entities/attendance.entity';
import { HolidayEntity } from '../entities/holiday.entity';
import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';
import { UserEntity } from '../../auth/entities/user.entity';
import { PolicyService } from '../../policy/policy.service';
import { WfhRequestService } from './wfh-request.service';
import {
  WorkLocationConfig,
  WfhConfig,
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
    const members = await this.memberships.find({
      where: {
        organizationId: c.orgId,
        departmentId: c.departmentScopeId,
        status: 'active',
      },
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
    return rows.find((r) => r.entryType !== 'manual') || null;
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
      // Reopen the existing day record with a fresh session segment.
      record.workSegments = [
        ...(record.workSegments || []),
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
    return this.attachEmployeeNames(rows);
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
    const named = await this.attachEmployeeNames(rows);
    if (q.search) {
      const needle = q.search.toLowerCase();
      return named.filter((r: any) =>
        (r.employeeName || '').toLowerCase().includes(needle),
      );
    }
    return named;
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
      const key = r.date.toISOString().slice(0, 10);
      const hours = r.effectiveWorkingHours ?? r.totalWorkingHours ?? 0;
      out.set(key, Math.round((Number(hours) || 0) * 100) / 100);
    }
    return out;
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
    opts: { view?: 'timeline' | 'grouped'; startDate?: string; endDate?: string },
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
    const scope = await this.departmentScopeIds(c);
    if (scope) where.employeeId = In([...scope]);
    const rows = await this.attachEmployeeNames(
      await this.repo.find({ where, order: { date: 'DESC' }, take: MAX_LIST_ROWS }),
    );

    const events: any[] = [];
    for (const r of rows as any[]) {
      for (const seg of r.workSegments || []) {
        events.push({
          employeeId: r.employeeId,
          employeeName: r.employeeName,
          type: 'clock_in',
          at: seg.checkInTime,
          date: r.date,
        });
        if (seg.checkOutTime) {
          events.push({
            employeeId: r.employeeId,
            employeeName: r.employeeName,
            type: 'clock_out',
            at: seg.checkOutTime,
            date: r.date,
          });
        }
      }
      if (r.status === 'absent') {
        events.push({
          employeeId: r.employeeId,
          employeeName: r.employeeName,
          type: 'absent',
          at: r.date,
          date: r.date,
        });
      }
    }
    events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    if (opts.view === 'grouped') {
      const byPerson = new Map<string, any>();
      for (const r of rows as any[]) {
        byPerson.set(r.employeeId, {
          employeeId: r.employeeId,
          employeeName: r.employeeName,
          status: r.status,
          totalHours: r.totalWorkingHours || 0,
          sessions: r.workSegments || [],
        });
      }
      return { view: 'grouped', data: [...byPerson.values()] };
    }
    return { view: 'timeline', data: events };
  }

  // ── name / department joins ─────────────────────────────────────────────────

  /** Attach `employeeName` to rows from the user directory (by auth userId). */
  private async attachEmployeeNames(
    rows: AttendanceEntity[],
  ): Promise<Array<AttendanceEntity & { employeeName: string }>> {
    if (!rows.length) return rows as any;
    const ids = [...new Set(rows.map((r) => r.employeeId))];
    const users = await this.users.find({ where: { id: In(ids) } });
    const nameById = new Map(
      users.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim() || u.email]),
    );
    return rows.map((r) => ({
      ...r,
      employeeName: nameById.get(r.employeeId) || 'Unknown',
    })) as any;
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
