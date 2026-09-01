import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { bootOrgTestApp, OrgTestHarness, CreatedOrg } from '../../organization/features/support/org-harness';
import { SalaryStructureEntity } from '../entities/salary-structure.entity';
import { PayslipEntity } from '../entities/payslip.entity';
import { TaxDeclarationEntity } from '../entities/tax-declaration.entity';

const feature = loadFeature('./tax-declaration.feature', { loadRelativePath: true });
const API = '/api/v1';
const MONTH = 9;
const YEAR = 2026;
const FY = 2026; // FY 2026-27 (April 2026 onward)
const MONTHLY = 125000; // ₹15L/yr — comfortably taxable under the old regime
const STD_DED_OLD = 50000;

interface Member { email: string; userId: string; token: string }

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let salaries: Repository<SalaryStructureEntity>;
  let payslips: Repository<PayslipEntity>;
  let decls: Repository<TaxDeclarationEntity>;
  const orgIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    salaries = h.app.get(getRepositoryToken(SalaryStructureEntity));
    payslips = h.app.get(getRepositoryToken(PayslipEntity));
    decls = h.app.get(getRepositoryToken(TaxDeclarationEntity));
  });
  afterAll(async () => {
    const ids = [...orgIds];
    if (ids.length) {
      await decls.delete({ organizationId: In(ids) }).catch(() => undefined);
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
      .send({ monthlySalary: MONTHLY, effectiveFrom: '2026-01-01' })
      .expect(200);
    await h
      .api()
      .put(`${API}/policies/payroll-config`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
      .send({ tds: { enabled: true, regime: 'old' } })
      .expect(200);
    return { o, member };
  };

  const saveDecl = (m: Member) =>
    h
      .api()
      .put(`${API}/payroll/tax-declarations/me?fy=${FY}`)
      .set('Authorization', `Bearer ${m.token}`)
      .send({ regime: 'old', section80C: 150000, section80D: 25000 });
  const submitDecl = (m: Member) =>
    h.api().post(`${API}/payroll/tax-declarations/me/submit?fy=${FY}`).set('Authorization', `Bearer ${m.token}`).send({});
  const generate = (o: CreatedOrg) =>
    h.api().post(`${API}/payroll/payslips/generate`).set('Authorization', `Bearer ${o.ownerToken}`).send({ month: MONTH, year: YEAR });
  const mySlips = (m: Member) =>
    h.api().get(`${API}/payroll/payslips/my`).set('Authorization', `Bearer ${m.token}`);

  test('an employee declares, HR verifies, and TDS uses the verified figures', ({ given, when, and, then }) => {
    let o: CreatedOrg;
    let member: Member;
    let declId: string;

    given('an organization with income tax on the old regime and an employee on a taxable salary', async () => {
      ({ o, member } = await setup());
    });
    when('the employee submits an investment declaration', async () => {
      await saveDecl(member).expect(200);
      const res = await submitDecl(member).expect(200);
      declId = res.body.data.id;
      expect(res.body.data.status).toBe('submitted');
    });
    and('the owner verifies the declaration', async () => {
      await h
        .api()
        .post(`${API}/payroll/tax-declarations/${declId}/review`)
        .set('Authorization', `Bearer ${o.ownerToken}`)
        .send({ action: 'verify' })
        .expect(200);
    });
    then('the declaration is verified', async () => {
      const res = await h
        .api()
        .get(`${API}/payroll/tax-declarations/me?fy=${FY}`)
        .set('Authorization', `Bearer ${member.token}`)
        .expect(200);
      expect(res.body.data.status).toBe('verified');
      expect(res.body.data.editable).toBe(false);
    });
    and("the employee's payslip TDS reflects the declared deductions", async () => {
      await generate(o).expect(200);
      const res = await mySlips(member).expect(200);
      const slip = res.body.data.find((s: any) => s.month === MONTH && s.year === YEAR);
      expect(slip.tds.regime).toBe('old');
      // annualGross 1,500,000 − std 50,000 − (80C 150,000 + 80D 25,000) = 1,275,000
      expect(slip.tds.annualTaxable).toBe(MONTHLY * 12 - STD_DED_OLD - 175000);
      expect(slip.tds.monthly).toBeGreaterThan(0);
    });
  });

  test('a plain employee cannot open the review queue', ({ given, when, then }) => {
    let member: Member;
    let status = 0;
    given('an organization with income tax on the old regime and an employee on a taxable salary', async () => {
      ({ member } = await setup());
    });
    when('the employee requests the review queue', async () => {
      const res = await h.api().get(`${API}/payroll/tax-declarations`).set('Authorization', `Bearer ${member.token}`);
      status = res.status;
    });
    then('the request is forbidden', () => {
      expect(status).toBe(403);
    });
  });

  test('an unverified declaration does not change TDS', ({ given, when, then }) => {
    let o: CreatedOrg;
    let member: Member;

    given('an organization with income tax on the old regime and an employee on a taxable salary', async () => {
      ({ o, member } = await setup());
    });
    when('the employee submits a declaration but it is not verified', async () => {
      await saveDecl(member).expect(200);
      await submitDecl(member).expect(200);
    });
    then("the employee's payslip TDS ignores the declared deductions", async () => {
      await generate(o).expect(200);
      const res = await mySlips(member).expect(200);
      const slip = res.body.data.find((s: any) => s.month === MONTH && s.year === YEAR);
      // No verified declaration → no exemptions: taxable = annualGross − std deduction.
      expect(slip.tds.annualTaxable).toBe(MONTHLY * 12 - STD_DED_OLD);
    });
  });
});
