import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { SalaryStructureEntity, SalaryComponent, RecurringDeduction } from '../entities/salary-structure.entity';
import { PayslipEntity, PayslipLine } from '../entities/payslip.entity';
import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';
import { UserEntity } from '../../auth/entities/user.entity';
import { OrganizationEntity } from '../../organization/entities/organization.entity';
import { DepartmentEntity } from '../../organization/entities/department.entity';
import { AttendanceService } from '../../attendance/services/attendance.service';
import { LeaveService } from '../../leave/services/leave.service';
import { PolicyService } from '../../policy/policy.service';
import { NotifierService } from '../../notification/notifier.service';
import { resolveLop, computeSimplePayslip, rupeesInWords } from '../payroll-calc';
import { computeStatutory, PayrollStatutoryConfig } from '../statutory';
import { SetSalaryDto, GeneratePayslipsDto } from '../dto';

/** Org roles that manage payroll (owners/admins) — never a payroll subject gate. */
@Injectable()
export class PayrollService {
  private readonly logger = new Logger(PayrollService.name);

  constructor(
    @InjectRepository(SalaryStructureEntity)
    private readonly salaries: Repository<SalaryStructureEntity>,
    @InjectRepository(PayslipEntity)
    private readonly payslips: Repository<PayslipEntity>,
    @InjectRepository(OrgMembershipEntity)
    private readonly memberships: Repository<OrgMembershipEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    @InjectRepository(OrganizationEntity)
    private readonly orgs: Repository<OrganizationEntity>,
    @InjectRepository(DepartmentEntity)
    private readonly departments: Repository<DepartmentEntity>,
    private readonly attendance: AttendanceService,
    private readonly leave: LeaveService,
    private readonly policy: PolicyService,
    private readonly notifier: NotifierService,
  ) {}

  // ── salary structures ───────────────────────────────────────────────────────

  private async nameEmail(userId: string) {
    const u = await this.users.findOne({ where: { id: userId } });
    const name = u ? `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email : null;
    return { name: name || null, email: u?.email ?? null };
  }

  async activeSalary(orgId: string, userId: string): Promise<SalaryStructureEntity | null> {
    return this.salaries.findOne({
      where: { organizationId: orgId, userId, isActive: true, isDeleted: false },
    });
  }

  /** Set (or revise) an employee's monthly salary — supersedes the active one. */
  async setSalary(orgId: string, userId: string, dto: SetSalaryDto, actorId: string) {
    const member = await this.memberships.findOne({
      where: { organizationId: orgId, userId, status: 'active' },
    });
    if (!member) throw new NotFoundException('That member is not in your organization');

    const prior = await this.activeSalary(orgId, userId);
    if (prior) {
      prior.isActive = false;
      await this.salaries.save(prior);
    }
    const { name, email } = await this.nameEmail(userId);
    const { components, monthlySalary } = this.normalizeComponents(
      dto.components,
      dto.monthlySalary,
    );
    const recurringDeductions = this.normalizeRecurring(dto.recurringDeductions);
    const saved = await this.salaries.save(
      this.salaries.create({
        organizationId: orgId,
        userId,
        employeeName: name,
        employeeEmail: email,
        monthlySalary,
        components,
        recurringDeductions,
        effectiveFrom: dto.effectiveFrom ? new Date(dto.effectiveFrom) : new Date(),
        supersedes: prior?.id ?? null,
        createdBy: actorId,
        isActive: true,
      }),
    );
    return this.salaryView(saved);
  }

  /** Clean per-employee recurring recoveries (fixed positive rupee amounts). */
  private normalizeRecurring(input: RecurringDeduction[] | undefined): RecurringDeduction[] {
    const seen = new Set<string>();
    const out: RecurringDeduction[] = [];
    for (const r of input || []) {
      const code = (r.code || '').trim().toUpperCase().slice(0, 20);
      const name = (r.name || '').trim().slice(0, 60);
      const amount = Math.max(0, Math.round(Number(r.amount) || 0));
      if (!code || !name || amount <= 0 || seen.has(code)) continue;
      seen.add(code);
      const total = r.total != null && Number(r.total) > 0 ? Math.round(Number(r.total)) : undefined;
      out.push(total != null ? { code, name, amount, total } : { code, name, amount });
    }
    return out;
  }

  /**
   * Reconcile a submitted component breakdown with the gross figure. If components
   * are given, gross is their sum (the breakdown is authoritative); otherwise the
   * whole salary is a single implicit Basic component. Rounds to whole rupees.
   */
  private normalizeComponents(
    input: SalaryComponent[] | undefined,
    monthlySalary: number,
  ): { components: SalaryComponent[]; monthlySalary: number } {
    const clean = (input || [])
      .map((c) => ({
        code: (c.code || '').trim().toUpperCase().slice(0, 20),
        name: (c.name || '').trim().slice(0, 60),
        amount: Math.max(0, Math.round(Number(c.amount) || 0)),
      }))
      .filter((c) => c.code && c.name && c.amount > 0);
    if (!clean.length) {
      return { components: [], monthlySalary: Math.round(monthlySalary) };
    }
    const sum = clean.reduce((t, c) => t + c.amount, 0);
    return { components: clean, monthlySalary: sum };
  }

  /** The Basic component amount that drives PF (else the whole salary is Basic). */
  private basicOf(salary: SalaryStructureEntity): number {
    const comps = salary.components || [];
    const basic = comps.find((c) => c.code === 'BASIC');
    if (basic) return Number(basic.amount);
    return comps.length ? 0 : Number(salary.monthlySalary);
  }

  /** Full-value earning lines (pre-LOP); a single Basic line when no breakdown. */
  private earningLines(salary: SalaryStructureEntity): PayslipLine[] {
    const comps = salary.components || [];
    if (comps.length) {
      return comps.map((c) => ({ code: c.code, name: c.name, amount: Number(c.amount) }));
    }
    return [{ code: 'BASIC', name: 'Basic', amount: Number(salary.monthlySalary) }];
  }

  async getSalary(orgId: string, userId: string) {
    const s = await this.activeSalary(orgId, userId);
    return s ? this.salaryView(s) : null;
  }

  /** Every active-salaried member (the payroll roster). */
  async listSalaries(orgId: string) {
    const rows = await this.salaries.find({
      where: { organizationId: orgId, isActive: true, isDeleted: false },
      order: { employeeName: 'ASC' },
    });
    return rows.map((s) => this.salaryView(s));
  }

  private salaryView(s: SalaryStructureEntity) {
    return {
      id: s.id,
      userId: s.userId,
      employeeName: s.employeeName,
      employeeEmail: s.employeeEmail,
      monthlySalary: Number(s.monthlySalary),
      components: (s.components || []).map((c) => ({
        code: c.code,
        name: c.name,
        amount: Number(c.amount),
      })),
      recurringDeductions: (s.recurringDeductions || []).map((r) => ({
        code: r.code,
        name: r.name,
        amount: Number(r.amount),
        ...(r.total != null ? { total: Number(r.total) } : {}),
      })),
      effectiveFrom: s.effectiveFrom,
    };
  }

  // ── payslip generation ────────────────────────────────────────────────────

  private monthBounds(month: number, year: number): { start: Date; end: Date } {
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 0)); // last day of month
    return { start, end };
  }

  /**
   * Sum every deduction line, by code, across the employee's payslips in STRICTLY
   * earlier months than (year, month) — the cumulative amount already recovered.
   * Strictly-earlier keeps this idempotent when the current month is regenerated.
   */
  private async recoveredBefore(
    orgId: string,
    userId: string,
    year: number,
    month: number,
  ): Promise<Map<string, number>> {
    const rows = await this.payslips.find({ where: { organizationId: orgId, userId, isDeleted: false } });
    const cutoff = year * 12 + (month - 1);
    const map = new Map<string, number>();
    for (const p of rows) {
      if (p.year * 12 + (p.month - 1) >= cutoff) continue;
      for (const d of p.deductions || []) {
        map.set(d.code, (map.get(d.code) || 0) + Number(d.amount || 0));
      }
    }
    return map;
  }

  /** Compute one employee's payslip figures for a month (no persistence). */
  private async computeFor(
    orgId: string,
    salary: SalaryStructureEntity,
    month: number,
    year: number,
    cfg: PayrollStatutoryConfig,
  ) {
    const { start, end } = this.monthBounds(month, year);
    // Only paid from when the salary takes effect within the month.
    const effFrom = salary.effectiveFrom > start ? salary.effectiveFrom : start;
    const [att, lv] = await Promise.all([
      this.attendance.getDaysSummary(orgId, salary.userId, effFrom, end),
      this.leave.leaveSummaryForPeriod(orgId, salary.userId, effFrom, end),
    ]);
    const lop = resolveLop({
      workingDays: att.workingDays,
      presentDays: att.presentDays,
      halfDays: att.halfDays,
      paidLeaveDays: lv.paidLeaveDays,
      lopLeaveDays: lv.lopLeaveDays,
      // Only dock unaccounted days when the org runs attendance-based payroll.
      dockUnaccounted: cfg.lopFromAttendance,
    });
    const comp = computeSimplePayslip(Number(salary.monthlySalary), lop);

    // Statutory runs on the LOP-adjusted (earned) wage: gross earned this month,
    // and the correspondingly-prorated Basic (PF's wage base). `percent_gross`
    // custom lines use the full (pre-LOP) gross; everything else uses earned.
    const fullGross = comp.grossEarnings;
    const earnedGross = Math.max(0, comp.grossEarnings - comp.lopDeduction);
    const paidRatio = fullGross > 0 ? earnedGross / fullGross : 0;
    const earnedBasic = Math.round(this.basicOf(salary) * paidRatio);
    const statutory = computeStatutory(earnedBasic, earnedGross, month, cfg, fullGross);

    // Line items. Earnings are full-value (pre-LOP), summing to grossEarnings; LOP
    // + statutory + custom + recurring sit on the deduction side.
    const earnings: PayslipLine[] = this.earningLines(salary);
    const deductions: PayslipLine[] = [];
    if (comp.lopDeduction > 0) {
      deductions.push({ code: 'LOP', name: 'Loss of Pay', amount: comp.lopDeduction });
    }
    if (statutory.pfEmployee > 0) {
      deductions.push({ code: 'PF', name: 'Provident Fund', amount: statutory.pfEmployee });
    }
    if (statutory.esiEmployee > 0) {
      deductions.push({ code: 'ESI', name: 'ESI', amount: statutory.esiEmployee });
    }
    if (statutory.professionalTax > 0) {
      deductions.push({ code: 'PT', name: 'Professional Tax', amount: statutory.professionalTax });
    }
    if (statutory.lwfEmployee > 0) {
      deductions.push({ code: 'LWF', name: 'Labour Welfare Fund', amount: statutory.lwfEmployee });
    }
    // Owner-defined org-wide custom deductions (employee side).
    for (const c of statutory.custom) {
      if (c.employee > 0) deductions.push({ code: c.code, name: c.name, amount: c.employee });
    }
    // Per-employee recurring recoveries (loan EMI, advance) — fixed, not prorated.
    // A capped recovery (`total` set) STOPS once earlier payslips have recovered it.
    const priorRecovered = await this.recoveredBefore(orgId, salary.userId, year, month);
    let recurringTotal = 0;
    for (const r of salary.recurringDeductions || []) {
      let amt = Math.max(0, Math.round(Number(r.amount) || 0));
      if (amt <= 0) continue;
      if (r.total != null) {
        const remaining = Math.max(0, Math.round(Number(r.total)) - (priorRecovered.get(r.code) || 0));
        amt = Math.min(amt, remaining);
        if (amt <= 0) continue; // fully recovered — no further deduction
      }
      recurringTotal += amt;
      deductions.push({ code: r.code, name: r.name, amount: amt });
    }

    const employerContributions: PayslipLine[] = [];
    if (statutory.pfEmployer > 0) {
      employerContributions.push({ code: 'PF_ER', name: 'PF (Employer)', amount: statutory.pfEmployer });
    }
    if (statutory.esiEmployer > 0) {
      employerContributions.push({ code: 'ESI_ER', name: 'ESI (Employer)', amount: statutory.esiEmployer });
    }
    if (statutory.lwfEmployer > 0) {
      employerContributions.push({ code: 'LWF_ER', name: 'LWF (Employer)', amount: statutory.lwfEmployer });
    }
    for (const c of statutory.custom) {
      if (c.employer > 0) employerContributions.push({ code: `${c.code}_ER`, name: `${c.name} (Employer)`, amount: c.employer });
    }

    const totalDeductions = comp.lopDeduction + statutory.employeeDeductions + recurringTotal;
    const netPay = Math.max(0, comp.grossEarnings - totalDeductions);

    return { comp, lop, statutory, earnings, deductions, employerContributions, totalDeductions, netPay };
  }

  /**
   * Generate (or regenerate) payslips for a month. One payslip per employee/month
   * (upsert on the unique key). Runs the given users, else every active-salaried
   * member. Returns the created/updated payslip views + a per-run summary.
   */
  async generatePayslips(orgId: string, dto: GeneratePayslipsDto, actorId: string) {
    let salaried = await this.salaries.find({
      where: { organizationId: orgId, isActive: true, isDeleted: false },
    });
    if (dto.userIds?.length) {
      const set = new Set(dto.userIds);
      salaried = salaried.filter((s) => set.has(s.userId));
    }
    if (!salaried.length) {
      throw new BadRequestException('No salaried employees to run — set salaries first');
    }

    const org = await this.orgs.findOne({ where: { id: orgId } });
    const cfg = await this.policy.getPayrollConfig(orgId);
    const results: ReturnType<typeof this.payslipView>[] = [];
    for (const salary of salaried) {
      try {
        const { comp, lop, statutory, earnings, deductions, employerContributions, totalDeductions, netPay } =
          await this.computeFor(orgId, salary, dto.month, dto.year, cfg);
        const member = await this.memberships.findOne({
          where: { organizationId: orgId, userId: salary.userId },
        });
        const dept = member?.departmentId
          ? await this.departments.findOne({ where: { id: member.departmentId } })
          : null;

        const existing = await this.payslips.findOne({
          where: { userId: salary.userId, year: dto.year, month: dto.month },
        });
        const row: PayslipEntity = existing ?? this.payslips.create({
          organizationId: orgId,
          userId: salary.userId,
          month: dto.month,
          year: dto.year,
        });
        row.monthlySalary = comp.monthlySalary;
        row.grossEarnings = comp.grossEarnings;
        row.lopDeduction = comp.lopDeduction;
        row.totalDeductions = totalDeductions;
        row.netPay = netPay;
        row.netPayWords = rupeesInWords(netPay);
        row.earnings = earnings;
        row.deductions = deductions;
        row.employerContributions = employerContributions;
        row.statutory = {
          pfEmployee: statutory.pfEmployee,
          pfEmployer: statutory.pfEmployer,
          pfWage: statutory.pfWage,
          esiEmployee: statutory.esiEmployee,
          esiEmployer: statutory.esiEmployer,
          professionalTax: statutory.professionalTax,
          lwfEmployee: statutory.lwfEmployee,
          lwfEmployer: statutory.lwfEmployer,
        };
        row.lopDetails = {
          workingDays: lop.workingDays,
          presentDays: lop.presentDays,
          halfDays: lop.halfDays,
          paidLeaveDays: lop.paidLeaveDays,
          lopLeaveDays: lop.lopLeaveDays,
          absentDays: lop.absentDays,
          lopDays: lop.lopDays,
          payableDays: comp.payableDays,
          perDayPay: comp.perDayPay,
        };
        row.employeeSnapshot = {
          userId: salary.userId,
          name: salary.employeeName,
          email: salary.employeeEmail,
          department: dept?.name ?? null,
          designation: member?.role ?? null,
        };
        row.orgSnapshot = { organizationId: orgId, name: org?.name ?? null };
        row.generatedBy = actorId;
        const saved = await this.payslips.save(row);
        results.push(this.payslipView(saved));

        // Notify the employee their payslip is ready.
        await this.notifier.notify({
          organizationId: orgId,
          userId: salary.userId,
          actorId,
          type: 'payroll_payslip_ready',
          title: 'Payslip ready',
          body: `Your payslip for ${this.monthLabel(dto.month)} ${dto.year} is available.`,
          data: { actionUrl: '/payroll/my', payslipId: saved.id },
        });
      } catch (err) {
        this.logger.error(`payslip failed for ${salary.userId}: ${String(err)}`);
      }
    }
    return {
      month: dto.month,
      year: dto.year,
      generated: results.length,
      skipped: salaried.length - results.length,
      payslips: results,
    };
  }

  private monthLabel(m: number): string {
    return [
      'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
      'September', 'October', 'November', 'December',
    ][m - 1] ?? String(m);
  }

  // ── reads ────────────────────────────────────────────────────────────────

  private payslipView(p: PayslipEntity) {
    return {
      id: p.id,
      userId: p.userId,
      month: p.month,
      year: p.year,
      monthLabel: this.monthLabel(p.month),
      monthlySalary: Number(p.monthlySalary),
      grossEarnings: Number(p.grossEarnings),
      lopDeduction: Number(p.lopDeduction),
      totalDeductions: Number(p.totalDeductions),
      netPay: Number(p.netPay),
      netPayWords: p.netPayWords,
      earnings: (p.earnings || []).map((l) => ({ ...l, amount: Number(l.amount) })),
      deductions: (p.deductions || []).map((l) => ({ ...l, amount: Number(l.amount) })),
      employerContributions: (p.employerContributions || []).map((l) => ({ ...l, amount: Number(l.amount) })),
      statutory: p.statutory || null,
      lopDetails: p.lopDetails,
      employeeSnapshot: p.employeeSnapshot,
      orgSnapshot: p.orgSnapshot,
      createdAt: p.createdAt,
    };
  }

  async myPayslips(orgId: string, userId: string, year?: number) {
    const where: Record<string, unknown> = { organizationId: orgId, userId, isDeleted: false };
    if (year) where.year = year;
    const rows = await this.payslips.find({ where, order: { year: 'DESC', month: 'DESC' } });
    return rows.map((p) => this.payslipView(p));
  }

  async listPayslips(orgId: string, month?: number, year?: number) {
    const where: Record<string, unknown> = { organizationId: orgId, isDeleted: false };
    if (month) where.month = month;
    if (year) where.year = year;
    const rows = await this.payslips.find({ where, order: { year: 'DESC', month: 'DESC' } });
    return rows.map((p) => this.payslipView(p));
  }

  async getPayslip(orgId: string, id: string, actorUserId: string, canManage: boolean) {
    const p = await this.payslips.findOne({ where: { id, organizationId: orgId, isDeleted: false } });
    if (!p) throw new NotFoundException('Payslip not found');
    if (p.userId !== actorUserId && !canManage) {
      throw new ForbiddenException('You can only view your own payslip');
    }
    return this.payslipView(p);
  }
}
