import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import request from 'supertest';

import { bootOrgTestApp, OrgTestHarness, CreatedOrg } from '../../organization/features/support/org-harness';
import { SalaryStructureEntity } from '../entities/salary-structure.entity';
import { PayslipEntity } from '../entities/payslip.entity';
import { PayrollRunEntity } from '../entities/payroll-run.entity';

const feature = loadFeature('./payroll-run.feature', { loadRelativePath: true });
const API = '/api/v1';
const MONTH = 9;
const YEAR = 2026;

interface Member { email: string; userId: string; token: string }

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let salaries: Repository<SalaryStructureEntity>;
  let payslips: Repository<PayslipEntity>;
  let runs: Repository<PayrollRunEntity>;
  const orgIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    salaries = h.app.get(getRepositoryToken(SalaryStructureEntity));
    payslips = h.app.get(getRepositoryToken(PayslipEntity));
    runs = h.app.get(getRepositoryToken(PayrollRunEntity));
  });
  afterAll(async () => {
    const ids = [...orgIds];
    if (ids.length) {
      await runs.delete({ organizationId: In(ids) }).catch(() => undefined);
      await payslips.delete({ organizationId: In(ids) }).catch(() => undefined);
      await salaries.delete({ organizationId: In(ids) }).catch(() => undefined);
    }
    await h.cleanup();
  });

  const setup = async (): Promise<{ o: CreatedOrg; member: Member }> => {
    const o = await h.createOrg();
    orgIds.add(o.orgId);
    const member = await h.createEmployeeMember(o);
    await h
      .api()
      .put(`${API}/payroll/salary/${member.userId}`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
      .send({ monthlySalary: 44000, effectiveFrom: '2026-01-01' })
      .expect(200);
    return { o, member };
  };

  const openRun = (o: CreatedOrg) =>
    h.api().post(`${API}/payroll/runs`).set('Authorization', `Bearer ${o.ownerToken}`).send({ month: MONTH, year: YEAR });
  const act = (o: CreatedOrg, id: string, action: string) =>
    h.api().post(`${API}/payroll/runs/${id}/${action}`).set('Authorization', `Bearer ${o.ownerToken}`).send({});
  const myPayslips = (m: Member) =>
    h.api().get(`${API}/payroll/payslips/my`).set('Authorization', `Bearer ${m.token}`);

  test('a run goes from draft through to finalized and publishes payslips', ({ given, when, then }) => {
    let o: CreatedOrg;
    let member: Member;
    let runId: string;

    given('an organization with an employee member on a salary', async () => {
      ({ o, member } = await setup());
    });
    when('the owner opens and processes a payroll run', async () => {
      const opened = await openRun(o).expect(201);
      runId = opened.body.data.id;
      expect(opened.body.data.status).toBe('draft');
      await act(o, runId, 'process').expect(200);
    });
    then('the run is in review with one employee and the member sees no payslip yet', async () => {
      const run = await h.api().get(`${API}/payroll/runs/${runId}`).set('Authorization', `Bearer ${o.ownerToken}`).expect(200);
      expect(run.body.data.status).toBe('review');
      expect(run.body.data.totals.employees).toBe(1);
      expect(run.body.data.payslips).toHaveLength(1);
      // Draft payslip is NOT visible to the employee.
      const mine = await myPayslips(member).expect(200);
      expect((mine.body.data as any[]).find((p) => p.month === MONTH && p.year === YEAR)).toBeUndefined();
    });
    when('the owner approves and finalizes the run', async () => {
      await act(o, runId, 'approve').expect(200);
      await act(o, runId, 'finalize').expect(200);
    });
    then('the run is finalized and the member now sees their published payslip', async () => {
      const run = await h.api().get(`${API}/payroll/runs/${runId}`).set('Authorization', `Bearer ${o.ownerToken}`).expect(200);
      expect(run.body.data.status).toBe('finalized');
      const mine = await myPayslips(member).expect(200);
      const slip = (mine.body.data as any[]).find((p) => p.month === MONTH && p.year === YEAR);
      expect(slip).toBeDefined();
      expect(slip.status).toBe('final');
      expect(slip.netPay).toBe(44000);
    });
  });

  test('a run cannot be finalized before it is approved', ({ given, when, then }) => {
    let o: CreatedOrg;
    let runId: string;
    given('an organization with an employee member on a salary', async () => {
      ({ o } = await setup());
    });
    when('the owner opens and processes a payroll run', async () => {
      const opened = await openRun(o).expect(201);
      runId = opened.body.data.id;
      await act(o, runId, 'process').expect(200);
    });
    then('finalizing the run before approval is rejected', async () => {
      const res = await act(o, runId, 'finalize');
      expect(res.status).toBe(400);
    });
  });

  test('an employee cannot drive a payroll run', ({ given, when, then }) => {
    let o: CreatedOrg;
    let member: Member;
    let runId: string;
    let res: request.Response;
    given('an organization with an employee member on a salary and a processed run', async () => {
      ({ o, member } = await setup());
      const opened = await openRun(o).expect(201);
      runId = opened.body.data.id;
      await act(o, runId, 'process').expect(200);
    });
    when('the employee tries to approve the run', async () => {
      res = await h
        .api()
        .post(`${API}/payroll/runs/${runId}/approve`)
        .set('Authorization', `Bearer ${member.token}`)
        .send({});
    });
    then('the run action is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });
});
