import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { SalaryStructureEntity } from '../entities/salary-structure.entity';
import { PayslipEntity } from '../entities/payslip.entity';
import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';
import { UserEntity } from '../../auth/entities/user.entity';
import { OrganizationEntity } from '../../organization/entities/organization.entity';
import { DepartmentEntity } from '../../organization/entities/department.entity';
import { AttendanceService } from '../../attendance/services/attendance.service';
import { LeaveService } from '../../leave/services/leave.service';
import { NotifierService } from '../../notification/notifier.service';
import { resolveLop, computeSimplePayslip, rupeesInWords } from '../payroll-calc';
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
    const saved = await this.salaries.save(
      this.salaries.create({
        organizationId: orgId,
        userId,
        employeeName: name,
        employeeEmail: email,
        monthlySalary: dto.monthlySalary,
        effectiveFrom: dto.effectiveFrom ? new Date(dto.effectiveFrom) : new Date(),
        supersedes: prior?.id ?? null,
        createdBy: actorId,
        isActive: true,
      }),
    );
    return this.salaryView(saved);
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
      effectiveFrom: s.effectiveFrom,
    };
  }

  // ── payslip generation ────────────────────────────────────────────────────

  private monthBounds(month: number, year: number): { start: Date; end: Date } {
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 0)); // last day of month
    return { start, end };
  }

  /** Compute one employee's payslip figures for a month (no persistence). */
  private async computeFor(orgId: string, salary: SalaryStructureEntity, month: number, year: number) {
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
    });
    const comp = computeSimplePayslip(Number(salary.monthlySalary), lop);
    return { comp, lop };
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
    const results: ReturnType<typeof this.payslipView>[] = [];
    for (const salary of salaried) {
      try {
        const { comp, lop } = await this.computeFor(orgId, salary, dto.month, dto.year);
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
        row.totalDeductions = comp.totalDeductions;
        row.netPay = comp.netPay;
        row.netPayWords = rupeesInWords(comp.netPay);
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
