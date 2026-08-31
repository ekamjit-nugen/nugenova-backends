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

  test('a member on approved paid leave for the month is paid in full', ({ given, when, then }) => {
    let o: CreatedOrg;
    let member: Member;
    given(
      'an organization with an employee member on a salary and paid leave all month',
      async () => {
        ({ o, member } = await orgWithMember());
        await setSalary(o, member.userId, 44000).expect(200);
        // Raise casual allocation so a whole month of paid leave fits the balance.
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
      },
    );
    when('the owner generates payslips for that month', async () => {
      await generate(o).expect(200);
    });
    then('the member\'s payslip has no loss-of-pay and the full net salary', async () => {
      const res = await myPayslips(member).expect(200);
      const slip = (res.body.data as any[]).find((p) => p.month === MONTH && p.year === YEAR);
      expect(slip).toBeDefined();
      expect(slip.lopDetails.lopDays).toBe(0);
      expect(slip.netPay).toBe(44000);
      expect(slip.lopDetails.paidLeaveDays).toBeGreaterThan(0);
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
