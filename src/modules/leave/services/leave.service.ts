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

import { LeaveRequestEntity } from '../entities/leave-request.entity';
import { LeaveBalanceEntity, LeaveBalanceLine } from '../entities/leave-balance.entity';
import { HolidayEntity } from '../../attendance/entities/holiday.entity';
import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';
import { UserEntity } from '../../auth/entities/user.entity';
import { NotifierService } from '../../notification/notifier.service';
import { PolicyService } from '../../policy/policy.service';
import { LEAVE_TYPE_DEFAULTS, type ResolvedLeaveType } from '../../policy/leave-config';
import { ApplyLeaveDto } from '../dto';
import { countLeaveDays, dayKey, rangesOverlap } from '../util/leave-days.util';

/** Org roles that manage leave rather than applying for it. */
const NON_APPLICANT_ROLES = new Set(['owner', 'admin']);
/** Org roles allowed to decide their OWN leave (maker-checker override). */
const SELF_DECIDE_ROLES = new Set(['owner', 'admin']);

@Injectable()
export class LeaveService {
  private readonly logger = new Logger(LeaveService.name);

  constructor(
    @InjectRepository(LeaveRequestEntity)
    private readonly leaves: Repository<LeaveRequestEntity>,
    @InjectRepository(LeaveBalanceEntity)
    private readonly balances: Repository<LeaveBalanceEntity>,
    @InjectRepository(HolidayEntity)
    private readonly holidays: Repository<HolidayEntity>,
    @InjectRepository(OrgMembershipEntity)
    private readonly memberships: Repository<OrgMembershipEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    private readonly notifier: NotifierService,
    private readonly policy: PolicyService,
  ) {}

  // ── config-driven types ─────────────────────────────────────────────────────

  /** Static label fallback for the 9 standard types (custom labels come from config). */
  private labelFor(key: string): string {
    return LEAVE_TYPE_DEFAULTS.find((t) => t.key === key)?.label ?? key;
  }

  /** Resolve the org's leave types (owner config, incl. customs), keyed by type. */
  private async resolvedTypes(orgId: string): Promise<Map<string, ResolvedLeaveType>> {
    const cfg = await this.policy.getLeaveConfig(orgId);
    return new Map(cfg.leaveTypes.map((t) => [t.key, t]));
  }

  private labelsOf(types: Map<string, ResolvedLeaveType>): Map<string, string> {
    return new Map([...types].map(([k, v]) => [k, v.label]));
  }

  private async labelsFor(orgId: string): Promise<Map<string, string>> {
    return this.labelsOf(await this.resolvedTypes(orgId));
  }

  /** The org's ENABLED leave types — the apply dropdown + balance seeding source. */
  async leaveTypes(orgId: string) {
    const cfg = await this.policy.getLeaveConfig(orgId);
    return cfg.leaveTypes
      .filter((t) => t.enabled)
      .map((t) => ({
        key: t.key,
        label: t.label,
        annualAllocation: t.annualAllocation,
        balanceTracked: t.balanceTracked,
        isLop: t.isLop,
      }));
  }

  private currentYear(): number {
    return new Date().getUTCFullYear();
  }

  // ── balances ─────────────────────────────────────────────────────────────

  /** available = opening + accrued + adjusted + carriedForward − used. */
  private recompute(line: LeaveBalanceLine): void {
    line.available =
      line.opening + line.accrued + line.adjusted + line.carriedForward - line.used;
  }

  private freshLine(leaveType: string, opening: number): LeaveBalanceLine {
    const line: LeaveBalanceLine = {
      leaveType,
      opening,
      accrued: 0,
      used: 0,
      adjusted: 0,
      carriedForward: 0,
      available: opening,
    };
    return line;
  }

  /**
   * Find (or lazily create) the employee's balance doc for a year, ensuring every
   * ENABLED balance-tracked type (from the org's leave CONFIG) has a line, with
   * `opening` reconciled to the current configured allocation. Recomputes
   * `available` on every read (used is preserved). Persists when it changed.
   */
  private async getOrInitBalance(
    orgId: string,
    userId: string,
    year: number,
  ): Promise<LeaveBalanceEntity> {
    let doc = await this.balances.findOne({ where: { userId, year } });
    let changed = false;
    if (!doc) {
      doc = this.balances.create({
        organizationId: orgId,
        userId,
        year,
        balances: [],
      });
      changed = true;
    }
    const types = await this.resolvedTypes(orgId);
    const byType = new Map(doc.balances.map((l) => [l.leaveType, l]));
    for (const t of types.values()) {
      if (!t.balanceTracked || !t.enabled) continue;
      let line = byType.get(t.key);
      if (!line) {
        line = this.freshLine(t.key, t.annualAllocation);
        doc.balances.push(line);
        byType.set(t.key, line);
        changed = true;
      } else if (line.opening !== t.annualAllocation) {
        // Owner changed the allocation → reconcile opening (keep used).
        line.opening = t.annualAllocation;
        changed = true;
      }
      const before = line.available;
      this.recompute(line);
      if (line.available !== before) changed = true;
    }
    if (changed) {
      doc.balances = [...doc.balances];
      doc = await this.balances.save(doc);
    }
    return doc;
  }

  private lineFor(doc: LeaveBalanceEntity, leaveType: string): LeaveBalanceLine | undefined {
    return doc.balances.find((l) => l.leaveType === leaveType);
  }

  private balanceView(doc: LeaveBalanceEntity, labels: Map<string, string>) {
    return {
      year: doc.year,
      balances: doc.balances.map((l) => ({
        leaveType: l.leaveType,
        label: labels.get(l.leaveType) ?? this.labelFor(l.leaveType),
        opening: l.opening,
        accrued: l.accrued,
        used: l.used,
        adjusted: l.adjusted,
        carriedForward: l.carriedForward,
        available: l.available,
      })),
    };
  }

  async myBalance(orgId: string, userId: string, year?: number) {
    const doc = await this.getOrInitBalance(orgId, userId, year ?? this.currentYear());
    return this.balanceView(doc, await this.labelsFor(orgId));
  }

  /** Manager view of another member's balance. */
  async balanceForUser(orgId: string, userId: string, year?: number) {
    const doc = await this.getOrInitBalance(orgId, userId, year ?? this.currentYear());
    return this.balanceView(doc, await this.labelsFor(orgId));
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private async membershipRole(orgId: string, userId: string): Promise<string> {
    const m = await this.memberships.findOne({
      where: { organizationId: orgId, userId, status: 'active' },
    });
    return m?.role ?? 'employee';
  }

  private async nameEmail(userId: string): Promise<{ name: string | null; email: string | null }> {
    const u = await this.users.findOne({ where: { id: userId } });
    if (!u) return { name: null, email: null };
    const name = `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email;
    return { name: name || null, email: u.email ?? null };
  }

  /** UTC-midnight day boundary from a date-only string. */
  private toDayStart(s: string): Date {
    const d = new Date(s);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }

  private async holidayKeys(orgId: string, start: Date, end: Date): Promise<Set<string>> {
    const rows = await this.holidays.find({
      where: { organizationId: orgId, isDeleted: false, date: Between(start, end) },
    });
    return new Set(rows.map((h) => dayKey(h.date)));
  }

  private toView(r: LeaveRequestEntity, labels?: Map<string, string>) {
    return {
      id: r.id,
      userId: r.userId,
      employeeName: r.employeeName,
      employeeEmail: r.employeeEmail,
      leaveType: r.leaveType,
      leaveTypeLabel: labels?.get(r.leaveType) ?? this.labelFor(r.leaveType),
      startDate: r.startDate,
      endDate: r.endDate,
      totalDays: Number(r.totalDays),
      halfDay: r.halfDay,
      halfDaySlot: r.halfDaySlot,
      reason: r.reason,
      status: r.status,
      reviewedBy: r.reviewedBy,
      reviewedAt: r.reviewedAt,
      reviewNote: r.reviewNote,
      createdAt: r.createdAt,
    };
  }

  // ── apply ─────────────────────────────────────────────────────────────────

  async apply(orgId: string, userId: string, orgRole: string, dto: ApplyLeaveDto) {
    if (NON_APPLICANT_ROLES.has(orgRole)) {
      throw new ForbiddenException('Owners and admins manage leave rather than applying');
    }
    const types = await this.resolvedTypes(orgId);
    const def = types.get(dto.leaveType);
    if (!def || !def.enabled) {
      throw new BadRequestException('That leave type is not offered by your organization');
    }
    const start = this.toDayStart(dto.startDate);
    const end = this.toDayStart(dto.endDate);
    if (end.getTime() < start.getTime()) {
      throw new BadRequestException('End date cannot be before start date');
    }

    const halfDay = !!dto.halfDay;
    if (halfDay && start.getTime() !== end.getTime()) {
      throw new BadRequestException('A half-day leave must be a single day');
    }

    const holidays = await this.holidayKeys(orgId, start, end);
    const totalDays = countLeaveDays({ start, end, halfDay, holidays });
    if (totalDays <= 0) {
      throw new BadRequestException(
        'The selected range has no working days (weekends/holidays only)',
      );
    }

    // Overlap: no two pending/approved leaves may overlap (any type).
    const existing = await this.leaves.find({
      where: {
        organizationId: orgId,
        userId,
        status: In(['pending', 'approved']),
        isDeleted: false,
      },
    });
    if (existing.some((e) => rangesOverlap(start, end, e.startDate, e.endDate))) {
      throw new ConflictException('You already have a leave that overlaps these dates');
    }

    // Balance check (skipped for lop / untracked types).
    if (def.balanceTracked) {
      const doc = await this.getOrInitBalance(orgId, userId, start.getUTCFullYear());
      const line = this.lineFor(doc, dto.leaveType);
      if (line && line.available < totalDays) {
        throw new BadRequestException(
          `Insufficient ${def.label} balance: ${line.available} day(s) left, ${totalDays} requested`,
        );
      }
    }

    const { name, email } = await this.nameEmail(userId);
    const saved = await this.leaves.save(
      this.leaves.create({
        organizationId: orgId,
        userId,
        employeeName: name,
        employeeEmail: email,
        leaveType: dto.leaveType,
        startDate: start,
        endDate: end,
        totalDays,
        halfDay,
        halfDaySlot: halfDay ? dto.halfDaySlot ?? 'first_half' : null,
        reason: dto.reason,
        status: 'pending',
      }),
    );

    await this.notifier.notifyManagers({
      organizationId: orgId,
      actorId: userId,
      resource: 'leaves',
      action: 'edit',
      type: 'leave_requested',
      title: 'Leave request to review',
      body: `${name ?? 'A team member'} requested ${def.label} (${totalDays} day${totalDays === 1 ? '' : 's'}).`,
      data: { actionUrl: '/leaves', leaveId: saved.id },
    });

    return this.toView(saved, this.labelsOf(types));
  }

  // ── decide (approve / reject) ───────────────────────────────────────────────

  private async getPending(orgId: string, id: string): Promise<LeaveRequestEntity> {
    const r = await this.leaves.findOne({ where: { id, organizationId: orgId, isDeleted: false } });
    if (!r) throw new NotFoundException('Leave request not found');
    return r;
  }

  private assertCanDecide(r: LeaveRequestEntity, actorUserId: string, actorRole: string): void {
    if (r.status !== 'pending') {
      throw new BadRequestException('This leave has already been actioned');
    }
    // Maker-checker: you can't decide your own leave unless owner/admin.
    if (r.userId === actorUserId && !SELF_DECIDE_ROLES.has(actorRole)) {
      throw new ForbiddenException('You cannot approve or reject your own leave');
    }
  }

  async approve(orgId: string, id: string, actorUserId: string, actorRole: string) {
    const r = await this.getPending(orgId, id);
    this.assertCanDecide(r, actorUserId, actorRole);

    const types = await this.resolvedTypes(orgId);
    const def = types.get(r.leaveType);
    if (def?.balanceTracked) {
      const doc = await this.getOrInitBalance(orgId, r.userId, r.startDate.getUTCFullYear());
      const line = this.lineFor(doc, r.leaveType);
      if (line) {
        line.used += Number(r.totalDays);
        this.recompute(line);
        doc.balances = [...doc.balances];
        await this.balances.save(doc);
      }
    }

    r.status = 'approved';
    r.reviewedBy = actorUserId;
    r.reviewedAt = new Date();
    const saved = await this.leaves.save(r);

    await this.notifier.notify({
      organizationId: orgId,
      userId: r.userId,
      actorId: actorUserId,
      type: 'leave_approved',
      title: 'Leave approved',
      body: `Your ${def?.label ?? r.leaveType} (${Number(r.totalDays)} day${Number(r.totalDays) === 1 ? '' : 's'}) was approved.`,
      data: { actionUrl: '/leaves', leaveId: r.id },
    });

    return this.toView(saved, this.labelsOf(types));
  }

  async reject(orgId: string, id: string, actorUserId: string, actorRole: string, note: string) {
    const r = await this.getPending(orgId, id);
    this.assertCanDecide(r, actorUserId, actorRole);

    r.status = 'rejected';
    r.reviewedBy = actorUserId;
    r.reviewedAt = new Date();
    r.reviewNote = note;
    const saved = await this.leaves.save(r);

    const types = await this.resolvedTypes(orgId);
    const def = types.get(r.leaveType);
    await this.notifier.notify({
      organizationId: orgId,
      userId: r.userId,
      actorId: actorUserId,
      type: 'leave_rejected',
      title: 'Leave request declined',
      body: `Your ${def?.label ?? r.leaveType} request was declined${note ? `: ${note}` : ''}.`,
      data: { actionUrl: '/leaves', leaveId: r.id },
      priority: 'high',
    });

    return this.toView(saved, this.labelsOf(types));
  }

  // ── cancel ───────────────────────────────────────────────────────────────

  async cancel(orgId: string, id: string, actorUserId: string, canManage: boolean, note?: string) {
    const r = await this.leaves.findOne({
      where: { id, organizationId: orgId, isDeleted: false },
    });
    if (!r) throw new NotFoundException('Leave request not found');

    const isOwner = r.userId === actorUserId;
    if (!isOwner && !canManage) {
      throw new ForbiddenException('You can only cancel your own leave');
    }
    if (r.status === 'rejected' || r.status === 'cancelled') {
      throw new BadRequestException('This leave cannot be cancelled');
    }

    const types = await this.resolvedTypes(orgId);

    // Restore balance if an approved leave is being cancelled.
    if (r.status === 'approved') {
      const def = types.get(r.leaveType);
      if (def?.balanceTracked) {
        const doc = await this.getOrInitBalance(orgId, r.userId, r.startDate.getUTCFullYear());
        const line = this.lineFor(doc, r.leaveType);
        if (line) {
          line.used = Math.max(0, line.used - Number(r.totalDays));
          this.recompute(line);
          doc.balances = [...doc.balances];
          await this.balances.save(doc);
        }
      }
    }

    const wasReviewedBy = r.reviewedBy;
    r.status = 'cancelled';
    r.reviewNote = note ?? r.reviewNote;
    const saved = await this.leaves.save(r);

    // Tell the approver an approved leave was cancelled (skip if the actor is them).
    if (wasReviewedBy && wasReviewedBy !== actorUserId) {
      const def = types.get(r.leaveType);
      await this.notifier.notify({
        organizationId: orgId,
        userId: wasReviewedBy,
        actorId: actorUserId,
        type: 'leave_cancelled',
        title: 'Leave cancelled',
        body: `${r.employeeName ?? 'A team member'} cancelled their ${def?.label ?? r.leaveType}.`,
        data: { actionUrl: '/leaves', leaveId: r.id },
      });
    }

    return this.toView(saved, this.labelsOf(types));
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async myLeaves(orgId: string, userId: string, status?: string) {
    const where: Record<string, unknown> = { organizationId: orgId, userId, isDeleted: false };
    if (status) where.status = status;
    const [rows, labels] = await Promise.all([
      this.leaves.find({ where, order: { createdAt: 'DESC' } }),
      this.labelsFor(orgId),
    ]);
    return rows.map((r) => this.toView(r, labels));
  }

  async list(orgId: string, status?: string) {
    const where: Record<string, unknown> = { organizationId: orgId, isDeleted: false };
    if (status) where.status = status;
    const [rows, labels] = await Promise.all([
      this.leaves.find({ where, order: { createdAt: 'DESC' } }),
      this.labelsFor(orgId),
    ]);
    return rows.map((r) => this.toView(r, labels));
  }

  async pendingApprovals(orgId: string) {
    return this.list(orgId, 'pending');
  }

  async getOne(orgId: string, id: string, actorUserId: string, canManage: boolean) {
    const r = await this.leaves.findOne({ where: { id, organizationId: orgId, isDeleted: false } });
    if (!r) throw new NotFoundException('Leave request not found');
    if (r.userId !== actorUserId && !canManage) {
      throw new ForbiddenException('You can only view your own leave');
    }
    return this.toView(r, await this.labelsFor(orgId));
  }

  async stats(orgId: string, userId: string) {
    const rows = await this.leaves.find({
      where: { organizationId: orgId, userId, isDeleted: false },
    });
    const by = (s: string) => rows.filter((r) => r.status === s).length;
    const totalDaysUsed = rows
      .filter((r) => r.status === 'approved')
      .reduce((sum, r) => sum + Number(r.totalDays), 0);
    return {
      pending: by('pending'),
      approved: by('approved'),
      rejected: by('rejected'),
      cancelled: by('cancelled'),
      totalDaysUsed,
    };
  }
}
