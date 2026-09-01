import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { bootOrgTestApp, OrgTestHarness, CreatedOrg } from '../../organization/features/support/org-harness';
import { SalaryStructureEntity } from '../entities/salary-structure.entity';
import { PayslipEntity } from '../entities/payslip.entity';

const feature = loadFeature('./form16.feature', { loadRelativePath: true });
const API = '/api/v1';
const YEAR = 2026;
const FY = 2026; // FY 2026-27
const MONTHLY = 125000;

interface Member { email: string; userId: string; token: string }

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let salaries: Repository<SalaryStructureEntity>;
  let payslips: Repository<PayslipEntity>;
  const orgIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    salaries = h.app.get(getRepositoryToken(SalaryStructureEntity));
    payslips = h.app.get(getRepositoryToken(PayslipEntity));
  });
  afterAll(async () => {
    const ids = [...orgIds];
    if (ids.length) {
      await payslips.delete({ organizationId: In(ids) }).catch(() => undefined);
      await salaries.delete({ organizationId: In(ids) }).catch(() => undefined);
    }
    await h.cleanup();
  });

  // Employee paid in Sep (Q2) and Dec (Q3) of FY 2026-27, income tax on.
  const setup = async (): Promise<{ o: CreatedOrg; member: Member }> => {
    const o = await h.createOrg();
    orgIds.add(o.orgId);
    const member = await h.createEmployeeMember(o);
    await h
      .api()
      .put(`${API}/payroll/salary/${member.userId}`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
      .send({ monthlySalary: MONTHLY, effectiveFrom: '2026-01-01' })
      .expect(200);
    await h
      .api()
      .put(`${API}/policies/payroll-config`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
      .send({ tds: { enabled: true, regime: 'new' } })
      .expect(200);
    for (const month of [9, 12]) {
      await h
        .api()
        .post(`${API}/payroll/payslips/generate`)
        .set('Authorization', `Bearer ${o.ownerToken}`)
        .send({ month, year: YEAR })
        .expect(200);
    }
    return { o, member };
  };

  test('an employee\'s Form 16 aggregates the FY payslips and tax', ({ given, when, then, and }) => {
    let o: CreatedOrg;
    let member: Member;
    let f16: any;

    given('an organization with income tax enabled and an employee paid across two months', async () => {
      ({ o, member } = await setup());
    });
    when('the employee downloads their Form 16 for the year', async () => {
      const res = await h
        .api()
        .get(`${API}/payroll/form16/me?fy=${FY}`)
        .set('Authorization', `Bearer ${member.token}`)
        .expect(200);
      f16 = res.body.data;
    });
    then('the Form 16 shows the gross salary and TDS deducted for the year', () => {
      expect(f16.financialYear).toBe('2026-27');
      expect(f16.assessmentYear).toBe('2027-28');
      expect(f16.months).toBe(2);
      expect(f16.grossSalary).toBe(MONTHLY * 2);
      expect(f16.tdsDeducted).toBeGreaterThan(0);
      expect(f16.employee.email).toBe(member.email);
    });
    and('the quarterly TDS adds up to the total deducted', () => {
      const q = f16.quarterlyTds;
      expect(q.q1 + q.q2 + q.q3 + q.q4).toBe(f16.tdsDeducted);
      expect(q.q2).toBeGreaterThan(0); // September
      expect(q.q3).toBeGreaterThan(0); // December
    });
  });

  test('an employee cannot fetch another member\'s Form 16', ({ given, when, then }) => {
    let o: CreatedOrg;
    let member: Member;
    let status = 0;

    given('an organization with income tax enabled and an employee paid across two months', async () => {
      ({ o, member } = await setup());
    });
    when('the employee requests a Form 16 for another user id', async () => {
      const res = await h
        .api()
        .get(`${API}/payroll/form16/${o.ownerId}?fy=${FY}`)
        .set('Authorization', `Bearer ${member.token}`);
      status = res.status;
    });
    then('the request is forbidden', () => {
      expect(status).toBe(403);
    });
  });
});
