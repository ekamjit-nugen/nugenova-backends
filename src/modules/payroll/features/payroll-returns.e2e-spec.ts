import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { bootOrgTestApp, OrgTestHarness, CreatedOrg } from '../../organization/features/support/org-harness';
import { SalaryStructureEntity } from '../entities/salary-structure.entity';
import { PayslipEntity } from '../entities/payslip.entity';
import { PayrollRunEntity } from '../entities/payroll-run.entity';

const feature = loadFeature('./payroll-returns.feature', { loadRelativePath: true });
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

  // Finalized month: salary set, PF/ESI/PT on, payslips generated (published `final`).
  const setupFinalized = async (): Promise<{ o: CreatedOrg; member: Member }> => {
    const o = await h.createOrg();
    orgIds.add(o.orgId);
    const member = await h.createEmployeeMember(o);
    await h
      .api()
      .put(`${API}/payroll/salary/${member.userId}`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
      .send({ monthlySalary: 30000, effectiveFrom: '2026-01-01', statutoryIds: { uan: '100200300400' } })
      .expect(200);
    await h
      .api()
      .put(`${API}/policies/payroll-config`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
      .send({ pf: { enabled: true }, esi: { enabled: false }, ptState: 'MH' })
      .expect(200);
    await h
      .api()
      .post(`${API}/payroll/payslips/generate`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
      .send({ month: MONTH, year: YEAR })
      .expect(200);
    return { o, member };
  };

  const getReturn = (o: CreatedOrg, type: string, token?: string) =>
    h
      .api()
      .get(`${API}/payroll/returns?type=${type}&month=${MONTH}&year=${YEAR}`)
      .set('Authorization', `Bearer ${token ?? o.ownerToken}`);

  test('owner downloads registers for a finalized month', ({ given, when, then, and }) => {
    let o: CreatedOrg;
    let member: Member;
    let register: { content: string; rowCount: number; filename: string };

    given('an organization that has finalized payroll with statutory deductions', async () => {
      ({ o, member } = await setupFinalized());
    });
    when('the owner downloads the payroll register', async () => {
      const res = await getReturn(o, 'register').expect(200);
      register = res.body.data;
    });
    then('the register lists the employee with gross, PF and net columns', () => {
      expect(register.rowCount).toBe(1);
      expect(register.filename).toBe('payroll-register-2026-09.csv');
      expect(register.content).toContain(member.email);
      expect(register.content).toContain('Net pay');
      expect(register.content).toContain('PF (employee)');
    });
    and('the PF register splits the employer contribution into EPS and EPF', async () => {
      const res = await getReturn(o, 'pf').expect(200);
      const pf = res.body.data;
      expect(pf.filename).toBe('pf-ecr-register-2026-09.csv');
      expect(pf.content).toContain('EPS contribution (ER)');
      expect(pf.content).toContain('EPF contribution (ER)');
      // The employee's UAN (from their salary's statutory IDs) fills the UAN column.
      expect(pf.content).toContain('100200300400');
      // Basic 30000 → PF wage capped 15000 → employer 1800 = EPS 1250 + EPF 550.
      expect(pf.content).toContain('1250');
      expect(pf.content).toContain('550');
    });
  });

  test('a plain employee cannot download returns', ({ given, when, then }) => {
    let o: CreatedOrg;
    let member: Member;
    let status = 0;

    given('an organization that has finalized payroll with statutory deductions', async () => {
      ({ o, member } = await setupFinalized());
    });
    when('a plain employee requests the payroll register', async () => {
      const res = await getReturn(o, 'register', member.token);
      status = res.status;
    });
    then('the request is forbidden', () => {
      expect(status).toBe(403);
    });
  });
});
