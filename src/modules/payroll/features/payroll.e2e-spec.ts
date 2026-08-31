import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import request from 'supertest';

import {
  bootOrgTestApp,
  OrgTestHarness,
  CreatedOrg,
} from '../../organization/features/support/org-harness';
import { SalaryStructureEntity } from '../entities/salary-structure.entity';
import { PayslipEntity } from '../entities/payslip.entity';
import { LeaveRequestEntity } from '../../leave/entities/leave-request.entity';
import { LeaveBalanceEntity } from '../../leave/entities/leave-balance.entity';
import { PolicyEntity } from '../../policy/entities/policy.entity';

const feature = loadFeature('./payroll.feature', { loadRelativePath: true });
const API = '/api/v1';
const MONTH = 9;
const YEAR = 2026; // September 2026 — 22 weekdays

interface Member {
  email: string;
  userId: string;
  token: string;
}

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let salaries: Repository<SalaryStructureEntity>;
  let payslips: Repository<PayslipEntity>;
  let leaves: Repository<LeaveRequestEntity>;
  let balances: Repository<LeaveBalanceEntity>;
  let policies: Repository<PolicyEntity>;
  const orgIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    salaries = h.app.get(getRepositoryToken(SalaryStructureEntity));
    payslips = h.app.get(getRepositoryToken(PayslipEntity));
    leaves = h.app.get(getRepositoryToken(LeaveRequestEntity));
    balances = h.app.get(getRepositoryToken(LeaveBalanceEntity));
    policies = h.app.get(getRepositoryToken(PolicyEntity));
  });
  afterAll(async () => {
    const ids = [...orgIds];
    if (ids.length) {
      await payslips.delete({ organizationId: In(ids) }).catch(() => undefined);
      await salaries.delete({ organizationId: In(ids) }).catch(() => undefined);
      await leaves.delete({ organizationId: In(ids) }).catch(() => undefined);
      await balances.delete({ organizationId: In(ids) }).catch(() => undefined);
      await policies.delete({ organizationId: In(ids) }).catch(() => undefined);
    }
    await h.cleanup();
  });

  const orgWithMember = async (): Promise<{ o: CreatedOrg; member: Member }> => {
    const o = await h.createOrg();
    orgIds.add(o.orgId);
    const member = await h.createEmployeeMember(o);
    return { o, member };
  };

  const setSalary = (o: CreatedOrg, userId: string, amount: number) =>
    h
      .api()
      .put(`${API}/payroll/salary/${userId}`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
      .send({ monthlySalary: amount, effectiveFrom: '2026-01-01' });

  const generate = (o: CreatedOrg) =>
    h
      .api()
      .post(`${API}/payroll/payslips/generate`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
      .send({ month: MONTH, year: YEAR });

  const myPayslips = (member: Member) =>
    h.api().get(`${API}/payroll/payslips/my`).set('Authorization', `Bearer ${member.token}`);

  const findSlip = (res: request.Response) =>
    (res.body.data as any[]).find((p) => p.month === MONTH && p.year === YEAR);

  /**
   * An org + member salaried and on approved paid leave for the whole of Sept 2026
   * (so the payslip has zero LOP and full gross — the clean base for the statutory
   * assertions). Pass `components` for a component-based structure.
   */
  const setupFullPaidMonth = async (
    salaryAmount: number,
    components?: { code: string; name: string; amount: number }[],
    recurringDeductions?: { code: string; name: string; amount: number }[],
  ): Promise<{ o: CreatedOrg; member: Member }> => {
    const { o, member } = await orgWithMember();
    await h
      .api()
      .put(`${API}/payroll/salary/${member.userId}`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
      .send({
        monthlySalary: salaryAmount,
        effectiveFrom: '2026-01-01',
        ...(components ? { components } : {}),
        ...(recurringDeductions ? { recurringDeductions } : {}),
      })
      .expect(200);
    await h
      .api()
      .put(`${API}/policies/leave-config`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
      .send({ leaveTypes: [{ key: 'casual', annualAllocation: 40, enabled: true }] })
      .expect(200);
    const applied = await h
      .api()
      .post(`${API}/leaves`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ leaveType: 'casual', startDate: '2026-09-01', endDate: '2026-09-30', reason: 'Sabbatical' })
      .expect(201);
    await h
      .api()
      .put(`${API}/leaves/${applied.body.data.id}/approve`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
      .expect(200);
    return { o, member };
  };

  test("the owner sets an employee's monthly salary", ({ given, when, then }) => {
    let o: CreatedOrg;
    let member: Member;
    given('an organization with an employee member', async () => {
      ({ o, member } = await orgWithMember());
    });
    when("the owner sets the member's salary to 44000", async () => {
      await setSalary(o, member.userId, 44000).expect(200);
    });
    then("reading the member's salary returns 44000", async () => {
      const res = await h
        .api()
        .get(`${API}/payroll/salary/${member.userId}`)
        .set('Authorization', `Bearer ${o.ownerToken}`)
        .expect(200);
      expect(res.body.data.monthlySalary).toBe(44000);
    });
  });

  test('an employee cannot set a salary', ({ given, when, then }) => {
    let member: Member;
    let res: request.Response;
    given('an organization with an employee member', async () => {
      ({ member } = await orgWithMember());
    });
    when('the employee tries to set their own salary', async () => {
      res = await h
        .api()
        .put(`${API}/payroll/salary/${member.userId}`)
        .set('Authorization', `Bearer ${member.token}`)
        .send({ monthlySalary: 99999 });
    });
    then('the salary write is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  test('an employee cannot run payroll', ({ given, when, then }) => {
    let o: CreatedOrg;
    let member: Member;
    let res: request.Response;
    given('an organization with an employee member on a salary', async () => {
      ({ o, member } = await orgWithMember());
      await setSalary(o, member.userId, 44000).expect(200);
    });
    when('the employee tries to generate payslips', async () => {
      res = await h
        .api()
        .post(`${API}/payroll/payslips/generate`)
        .set('Authorization', `Bearer ${member.token}`)
        .send({ month: MONTH, year: YEAR });
    });
    then('the payroll run is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  test('a member with no attendance is fully docked', ({ given, when, then }) => {
    let o: CreatedOrg;
    let member: Member;
    given('an organization with an employee member on a salary', async () => {
      ({ o, member } = await orgWithMember());
      await setSalary(o, member.userId, 44000).expect(200);
    });
    when('the owner generates payslips for that month', async () => {
      await generate(o).expect(200);
    });
    then('the member\'s payslip is fully loss-of-pay with zero net', async () => {
      const res = await myPayslips(member).expect(200);
      const slip = (res.body.data as any[])[0];
      expect(slip).toBeDefined();
      expect(slip.netPay).toBe(0);
      expect(slip.lopDetails.lopDays).toBe(slip.lopDetails.workingDays);
      expect(slip.lopDetails.workingDays).toBeGreaterThan(0);
    });
  });

  test('a member on approved paid leave for the month has no loss-of-pay', ({ given, when, then }) => {
    let o: CreatedOrg;
    let member: Member;
    given('an organization with an employee member on a salary and paid leave all month', async () => {
      ({ o, member } = await setupFullPaidMonth(44000));
    });
    when('the owner generates payslips for that month', async () => {
      await generate(o).expect(200);
    });
    then("the member's payslip has no loss-of-pay and full gross earnings", async () => {
      const slip = findSlip(await myPayslips(member).expect(200));
      expect(slip).toBeDefined();
      expect(slip.lopDetails.lopDays).toBe(0);
      expect(slip.lopDeduction).toBe(0);
      expect(slip.grossEarnings).toBe(44000);
      expect(slip.lopDetails.paidLeaveDays).toBeGreaterThan(0);
    });
  });

  test('statutory deductions reduce net pay', ({ given, when, then }) => {
    let o: CreatedOrg;
    let member: Member;
    given('an organization with an employee member on a salary and paid leave all month', async () => {
      ({ o, member } = await setupFullPaidMonth(44000));
    });
    when('the owner generates payslips for that month', async () => {
      await generate(o).expect(200);
    });
    then(
      "the member's payslip deducts provident fund and professional tax and shows the employer contribution",
      async () => {
        const slip = findSlip(await myPayslips(member).expect(200));
        expect(slip).toBeDefined();
        // Default config: PF employee = 12% of the 15000 wage ceiling = 1800; PT (MH) = 200;
        // ESI does not apply (gross 44000 > 21000). Net = 44000 − 1800 − 200 = 42000.
        expect(slip.statutory.pfEmployee).toBe(1800);
        expect(slip.statutory.pfEmployer).toBe(1800);
        expect(slip.statutory.professionalTax).toBe(200);
        expect(slip.statutory.esiEmployee).toBe(0);
        expect(slip.totalDeductions).toBe(2000);
        expect(slip.netPay).toBe(42000);
        const codes = (slip.deductions as any[]).map((d) => d.code);
        expect(codes).toEqual(expect.arrayContaining(['PF', 'PT']));
        const erCodes = (slip.employerContributions as any[]).map((d) => d.code);
        expect(erCodes).toContain('PF_ER');
      },
    );
  });

  test('the owner turns statutory deductions off through payroll policy', ({ given, and, when, then }) => {
    let o: CreatedOrg;
    let member: Member;
    given('an organization with an employee member on a salary and paid leave all month', async () => {
      ({ o, member } = await setupFullPaidMonth(44000));
    });
    and('the owner disables PF, ESI and professional tax', async () => {
      await h
        .api()
        .put(`${API}/policies/payroll-config`)
        .set('Authorization', `Bearer ${o.ownerToken}`)
        .send({ pf: { enabled: false }, esi: { enabled: false }, ptState: 'none' })
        .expect(200);
    });
    when('the owner generates payslips for that month', async () => {
      await generate(o).expect(200);
    });
    then("the member's payslip has no statutory deductions and net equals gross", async () => {
      const slip = findSlip(await myPayslips(member).expect(200));
      expect(slip).toBeDefined();
      expect(slip.statutory.pfEmployee).toBe(0);
      expect(slip.statutory.esiEmployee).toBe(0);
      expect(slip.statutory.professionalTax).toBe(0);
      expect(slip.totalDeductions).toBe(0);
      expect(slip.netPay).toBe(44000);
    });
  });

  test('salary components drive the payslip earnings and PF wage', ({ given, when, then }) => {
    let o: CreatedOrg;
    let member: Member;
    given(
      'an organization with an employee member on a component-based salary and paid leave all month',
      async () => {
        // Basic 12000 (< 15000 ceiling ⇒ PF wage = Basic), HRA 6000, Special 2000 ⇒ gross 20000.
        ({ o, member } = await setupFullPaidMonth(0, [
          { code: 'BASIC', name: 'Basic', amount: 12000 },
          { code: 'HRA', name: 'House Rent Allowance', amount: 6000 },
          { code: 'SPECIAL', name: 'Special Allowance', amount: 2000 },
        ]));
      },
    );
    when('the owner generates payslips for that month', async () => {
      await generate(o).expect(200);
    });
    then('the payslip earnings list the components and PF is computed on the Basic', async () => {
      const slip = findSlip(await myPayslips(member).expect(200));
      expect(slip).toBeDefined();
      expect(slip.grossEarnings).toBe(20000);
      const earnCodes = (slip.earnings as any[]).map((e) => e.code);
      expect(earnCodes).toEqual(expect.arrayContaining(['BASIC', 'HRA', 'SPECIAL']));
      // PF wage = Basic 12000 (under ceiling) ⇒ employee PF = 12% = 1440.
      expect(slip.statutory.pfWage).toBe(12000);
      expect(slip.statutory.pfEmployee).toBe(1440);
      // ESI applies (gross 20000 ≤ 21000): 0.75% of 20000 = 150.
      expect(slip.statutory.esiEmployee).toBe(150);
    });
  });

  test('an owner-defined custom deduction is applied to everyone', ({ given, and, when, then }) => {
    let o: CreatedOrg;
    let member: Member;
    given('an organization with an employee member on a salary and paid leave all month', async () => {
      ({ o, member } = await setupFullPaidMonth(44000));
    });
    and('the owner adds a custom insurance deduction of 500', async () => {
      await h
        .api()
        .put(`${API}/policies/payroll-config`)
        .set('Authorization', `Bearer ${o.ownerToken}`)
        .send({
          customDeductions: [
            { code: 'INS', name: 'Group Insurance', basis: 'fixed', employeeValue: 500, employerValue: 0 },
          ],
        })
        .expect(200);
    });
    when('the owner generates payslips for that month', async () => {
      await generate(o).expect(200);
    });
    then("the member's payslip includes the custom deduction and it reduces net pay", async () => {
      const slip = findSlip(await myPayslips(member).expect(200));
      expect(slip).toBeDefined();
      const ins = (slip.deductions as any[]).find((d) => d.code === 'INS');
      expect(ins).toBeDefined();
      expect(ins.amount).toBe(500);
      // Default statutory (PF 1800 + PT 200) + custom 500 = 2500 off 44000.
      expect(slip.netPay).toBe(44000 - 1800 - 200 - 500);
    });
  });

  test('a per-employee recurring deduction is recovered from that employee only', ({ given, when, then }) => {
    let o: CreatedOrg;
    let member: Member;
    given(
      'an organization with an employee member on a salary with a 2000 loan recovery and paid leave all month',
      async () => {
        ({ o, member } = await setupFullPaidMonth(44000, undefined, [
          { code: 'LOAN', name: 'Loan Recovery', amount: 2000 },
        ]));
      },
    );
    when('the owner generates payslips for that month', async () => {
      await generate(o).expect(200);
    });
    then("the member's payslip deducts the 2000 loan recovery", async () => {
      const slip = findSlip(await myPayslips(member).expect(200));
      expect(slip).toBeDefined();
      const loan = (slip.deductions as any[]).find((d) => d.code === 'LOAN');
      expect(loan).toBeDefined();
      expect(loan.amount).toBe(2000);
      // PF 1800 + PT 200 + loan 2000 = 4000 off 44000.
      expect(slip.netPay).toBe(44000 - 1800 - 200 - 2000);
    });
  });

  test("a member cannot read another member's payslip", ({ given, when, then }) => {
    let o: CreatedOrg;
    let a: Member;
    let b: Member;
    let bSlipId: string;
    let res: request.Response;
    given('an organization with two members who both have payslips', async () => {
      ({ o, member: a } = await orgWithMember());
      b = await h.createEmployeeMember(o);
      await setSalary(o, a.userId, 30000).expect(200);
      await setSalary(o, b.userId, 30000).expect(200);
      await generate(o).expect(200);
      const bSlips = await myPayslips(b).expect(200);
      bSlipId = (bSlips.body.data as any[])[0].id;
    });
    when("one member requests the other's payslip", async () => {
      res = await h
        .api()
        .get(`${API}/payroll/payslips/${bSlipId}`)
        .set('Authorization', `Bearer ${a.token}`);
    });
    then('the payslip read is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });
});
