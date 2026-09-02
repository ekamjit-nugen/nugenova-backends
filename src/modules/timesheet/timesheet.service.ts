import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { TimesheetEntity, TimesheetEntry, TimesheetCadence } from './entities/timesheet.entity';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { PolicyService } from '../policy/policy.service';
import { AttendanceService } from '../attendance/services/attendance.service';
import { NotifierService } from '../notification/notifier.service';
import { SaveTimesheetDto, ReviewTimesheetDto } from './dto';

const DAY_MS = 86_400_000;
const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

@Injectable()
export class TimesheetService {
  constructor(
    @InjectRepository(TimesheetEntity)
    private readonly sheets: Repository<TimesheetEntity>,
    @InjectRepository(OrgMembershipEntity)
    private readonly memberships: Repository<OrgMembershipEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    private readonly policy: PolicyService,
    private readonly attendance: AttendanceService,
    private readonly notifier: NotifierService,
  ) {}

  /** The period (UTC-midnight start/end) for a cadence around a reference date. */
  periodFor(cadence: TimesheetCadence, ref: Date): { start: Date; end: Date } {
    const y = ref.getUTCFullYear();
    const m = ref.getUTCMonth();
    const d = ref.getUTCDate();
    if (cadence === 'weekly') {
      const dow = new Date(Date.UTC(y, m, d)).getUTCDay(); // 0=Sun..6=Sat
      const back = (dow + 6) % 7; // days since Monday
      const start = new Date(Date.UTC(y, m, d - back));
      const end = new Date(start.getTime() + 6 * DAY_MS);
      return { start, end };
    }
    // monthly: 1st .. last day of the ref month
    const start = new Date(Date.UTC(y, m, 1));
    const end = new Date(Date.UTC(y, m + 1, 0));
    return { start, end };
  }

  private label(s: Date, e: Date, cadence: TimesheetCadence): string {
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    return cadence === 'weekly' ? `${fmt(s)} → ${fmt(e)}` : s.toISOString().slice(0, 7);
  }

  /**
   * The period's entries — built ONLY from days the employee actually logged
   * time (from attendance clock-ins). No manufactured empty rows; the employee
   * edits the hours the clock captured, then submits for approval.
   */
  private async buildEntries(orgId: string, userId: string, start: Date, end: Date): Promise<TimesheetEntry[]> {
    const hours = await this.attendance.hoursByDay(orgId, userId, start, end);
    return [...hours.keys()]
      .sort()
      .map((date) => ({ date, hours: r2(hours.get(date) ?? 0), note: '' }));
  }

  private view(t: TimesheetEntity, cadence: TimesheetCadence) {
    return {
      id: t.id,
      userId: t.userId,
      cadence: t.cadence,
      periodStart: t.periodStart,
      periodEnd: t.periodEnd,
      periodLabel: this.label(t.periodStart, t.periodEnd, cadence),
      entries: t.entries || [],
      totalHours: Number(t.totalHours),
      status: t.status,
      submittedAt: t.submittedAt,
      reviewedBy: t.reviewedBy,
      reviewedAt: t.reviewedAt,
      reviewNote: t.reviewNote,
      editable: t.status === 'draft' || t.status === 'rejected',
      createdAt: t.createdAt,
    };
  }

  private async find(orgId: string, userId: string, start: Date) {
    return this.sheets.findOne({ where: { organizationId: orgId, userId, periodStart: start, isDeleted: false } });
  }

  private async nameEmail(userId: string) {
    const u = await this.users.findOne({ where: { id: userId } });
    const name = u ? `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email : null;
    return { name: name || null, email: u?.email ?? null };
  }

  /** The caller's timesheet for a period — a fresh, attendance-filled draft if none exists. */
  async myTimesheet(orgId: string, userId: string, refStr?: string) {
    const cfg = await this.policy.getTimesheetConfig(orgId);
    const ref = refStr ? new Date(refStr) : new Date();
    const { start, end } = this.periodFor(cfg.cadence, ref);
    const row = await this.find(orgId, userId, start);
    if (row) return { config: cfg, timesheet: this.view(row, cfg.cadence) };

    const entries = await this.buildEntries(orgId, userId, start, end);
    const draft: any = {
      id: null,
      userId,
      cadence: cfg.cadence,
      periodStart: start,
      periodEnd: end,
      periodLabel: this.label(start, end, cfg.cadence),
      entries,
      totalHours: r2(entries.reduce((s, e) => s + (Number(e.hours) || 0), 0)),
      status: 'draft' as const,
      submittedAt: null,
      reviewedBy: null,
      reviewedAt: null,
      reviewNote: null,
      editable: true,
      createdAt: null,
    };
    return { config: cfg, timesheet: draft };
  }

  private cleanEntries(input: SaveTimesheetDto['entries'], allowEdits: boolean, prefill: TimesheetEntry[]): TimesheetEntry[] {
    // When edits are off, the hours come from attendance (prefill); only notes are kept.
    const byDate = new Map((input || []).map((e) => [e.date, e]));
    if (!allowEdits) {
      return prefill.map((p) => ({ ...p, note: (byDate.get(p.date)?.note || '').slice(0, 200) }));
    }
    return (input || [])
      .filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date))
      .map((e) => ({ date: e.date, hours: Math.min(24, Math.max(0, r2(e.hours))), note: (e.note || '').slice(0, 200) }));
  }

  private async ensureRow(orgId: string, userId: string, cfg: { cadence: TimesheetCadence }, ref: Date) {
    const { start, end } = this.periodFor(cfg.cadence, ref);
    let row = await this.find(orgId, userId, start);
    if (!row) {
      const { name, email } = await this.nameEmail(userId);
      const entries = await this.buildEntries(orgId, userId, start, end);
      row = this.sheets.create({
        organizationId: orgId, userId, employeeName: name, employeeEmail: email,
        cadence: cfg.cadence, periodStart: start, periodEnd: end,
        entries, totalHours: r2(entries.reduce((s, e) => s + (Number(e.hours) || 0), 0)),
      });
    }
    return row;
  }

  /** Save the caller's timesheet draft for a period. */
  async saveMine(orgId: string, userId: string, refStr: string | undefined, dto: SaveTimesheetDto) {
    const cfg = await this.policy.getTimesheetConfig(orgId);
    if (!cfg.enabled) throw new BadRequestException('Timesheets are not enabled for your organization.');
    const ref = refStr ? new Date(refStr) : new Date();
    const row = await this.ensureRow(orgId, userId, cfg, ref);
    if (row.status === 'submitted') throw new ConflictException('This timesheet is submitted and awaiting review.');
    if (row.status === 'approved') throw new ConflictException('This timesheet is approved and locked.');
    const prefill = await this.buildEntries(orgId, userId, row.periodStart, row.periodEnd);
    row.entries = this.cleanEntries(dto.entries, cfg.allowEdits, prefill);
    row.totalHours = r2(row.entries.reduce((s, e) => s + (Number(e.hours) || 0), 0));
    if (row.status === 'rejected') { row.status = 'draft'; row.reviewNote = null; row.reviewedBy = null; row.reviewedAt = null; }
    const saved = await this.sheets.save(row);
    return this.view(saved, cfg.cadence);
  }

  /** Submit the caller's timesheet for approval. */
  async submitMine(orgId: string, userId: string, refStr: string | undefined, dto: SaveTimesheetDto) {
    const cfg = await this.policy.getTimesheetConfig(orgId);
    if (!cfg.enabled) throw new BadRequestException('Timesheets are not enabled for your organization.');
    // Persist any latest edits first.
    await this.saveMine(orgId, userId, refStr, dto);
    const ref = refStr ? new Date(refStr) : new Date();
    const { start } = this.periodFor(cfg.cadence, ref);
    const row = await this.find(orgId, userId, start);
    if (!row) throw new NotFoundException('Timesheet not found.');
    row.status = 'submitted';
    row.submittedAt = new Date();
    row.reviewedBy = null; row.reviewedAt = null; row.reviewNote = null;
    const saved = await this.sheets.save(row);

    await this.notifier.notifyManagers({
      organizationId: orgId, resource: 'attendance', action: 'view', actorId: userId,
      type: 'timesheet_submitted', title: 'Timesheet submitted',
      body: `An employee submitted their ${this.label(saved.periodStart, saved.periodEnd, cfg.cadence)} timesheet (${saved.totalHours}h).`,
      data: { actionUrl: '/timesheets', timesheetId: saved.id },
    });
    return this.view(saved, cfg.cadence);
  }

  /** Manager review queue — submitted timesheets by default. */
  async listForReview(orgId: string, opts: { status?: string } = {}) {
    const cfg = await this.policy.getTimesheetConfig(orgId);
    const where: Record<string, unknown> = { organizationId: orgId, isDeleted: false };
    if (opts.status) where.status = opts.status;
    const rows = await this.sheets.find({ where, order: { submittedAt: 'DESC', createdAt: 'DESC' } });
    const names = await this.nameMap(orgId, rows.map((r) => r.userId));
    return rows.map((r) => ({ ...this.view(r, r.cadence as TimesheetCadence), employee: names.get(r.userId) || null }));
  }

  /** Approve or reject a submitted timesheet (reviewer ≠ owner-of-sheet, owner exempt). */
  async review(orgId: string, id: string, reviewer: { userId: string; role?: string }, dto: ReviewTimesheetDto) {
    const row = await this.sheets.findOne({ where: { id, organizationId: orgId, isDeleted: false } });
    if (!row) throw new NotFoundException('Timesheet not found');
    if (row.status !== 'submitted') throw new ConflictException(`Only a submitted timesheet can be reviewed (this one is ${row.status}).`);
    if (row.userId === reviewer.userId && (reviewer.role || '').toLowerCase() !== 'owner') {
      throw new ForbiddenException('Separation of duties — you cannot review your own timesheet.');
    }
    row.status = dto.action === 'approve' ? 'approved' : 'rejected';
    row.reviewedBy = reviewer.userId;
    row.reviewedAt = new Date();
    row.reviewNote = dto.note?.slice(0, 500) || null;
    const saved = await this.sheets.save(row);

    await this.notifier.notify({
      organizationId: orgId, userId: row.userId, actorId: reviewer.userId,
      type: dto.action === 'approve' ? 'timesheet_approved' : 'timesheet_rejected',
      title: dto.action === 'approve' ? 'Timesheet approved' : 'Timesheet needs changes',
      body: dto.action === 'approve'
        ? `Your ${this.label(row.periodStart, row.periodEnd, row.cadence as TimesheetCadence)} timesheet was approved.`
        : `Your ${this.label(row.periodStart, row.periodEnd, row.cadence as TimesheetCadence)} timesheet was returned${row.reviewNote ? `: ${row.reviewNote}` : ''}.`,
      data: { actionUrl: '/timesheets', timesheetId: saved.id },
    });
    return this.view(saved, row.cadence as TimesheetCadence);
  }

  private async nameMap(orgId: string, userIds: string[]) {
    const ids = [...new Set(userIds.filter(Boolean))];
    const map = new Map<string, { name: string | null; email: string | null }>();
    if (!ids.length) return map;
    const [mems, users] = await Promise.all([
      this.memberships.find({ where: { organizationId: orgId, userId: In(ids) } }),
      this.users.find({ where: { id: In(ids) } }),
    ]);
    const userById = new Map(users.map((u) => [u.id, u]));
    for (const m of mems) {
      if (!m.userId) continue;
      const u = userById.get(m.userId);
      map.set(m.userId, { name: [u?.firstName, u?.lastName].filter(Boolean).join(' ') || null, email: u?.email || null });
    }
    return map;
  }
}
