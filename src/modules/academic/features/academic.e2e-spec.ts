import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import request from 'supertest';

import {
  bootOrgTestApp,
  OrgTestHarness,
  CreatedOrg,
} from '../../organization/features/support/org-harness';
import { AcademicYearEntity } from '../entities/academic-year.entity';
import { TermEntity } from '../entities/term.entity';
import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';
import { newObjectId } from '../../../bootstrap/database/object-id';

const feature = loadFeature('./academic.feature', { loadRelativePath: true });
const API = '/api/v1';

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let years: Repository<AcademicYearEntity>;
  let terms: Repository<TermEntity>;
  let memberships: Repository<OrgMembershipEntity>;
  const orgIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    years = h.app.get(getRepositoryToken(AcademicYearEntity));
    terms = h.app.get(getRepositoryToken(TermEntity));
    memberships = h.app.get(getRepositoryToken(OrgMembershipEntity));
  });
  afterAll(async () => {
    const ids = [...orgIds];
    if (ids.length) {
      await terms.delete({ organizationId: In(ids) }).catch(() => undefined);
      await years.delete({ organizationId: In(ids) }).catch(() => undefined);
    }
    await h.cleanup();
  });

  const org = async () => {
    const o = await h.createOrg();
    orgIds.add(o.orgId);
    return o;
  };
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const createYear = (o: CreatedOrg, body: any, token = o.ownerToken) =>
    h.api().post(`${API}/academic/years`).set(auth(token)).send(body);

  const yearBody = (name = '2025-26') => ({
    name,
    startDate: '2025-06-01',
    endDate: '2026-05-31',
  });

  test('an owner creates an academic year', ({ given, when, then }) => {
    let o: CreatedOrg;
    let res: request.Response;
    given('an organization', async () => {
      o = await org();
    });
    when(
      /^the owner creates an academic year "(.*)" from "(.*)" to "(.*)"$/,
      async (name, startDate, endDate) => {
        res = await createYear(o, { name, startDate, endDate });
      },
    );
    then('the academic year is created and is not current by default', () => {
      expect(res.status).toBe(201);
      expect(res.body.data.name).toBe('2025-26');
      expect(res.body.data.isCurrent).toBe(false);
    });
  });

  test('only one academic year can be current per org', ({ given, when, then }) => {
    let o: CreatedOrg;
    let firstId: string;
    let secondId: string;
    given('an organization with two academic years', async () => {
      o = await org();
      const a = await createYear(o, { name: '2024-25', startDate: '2024-06-01', endDate: '2025-05-31', isCurrent: true }).expect(201);
      firstId = a.body.data.id;
      expect(a.body.data.isCurrent).toBe(true);
      const b = await createYear(o, yearBody('2025-26')).expect(201);
      secondId = b.body.data.id;
    });
    when('the owner marks the second year as current', async () => {
      await h.api().put(`${API}/academic/years/${secondId}/current`).set(auth(o.ownerToken)).send({}).expect(200);
    });
    then('the second year is current and the first is not', async () => {
      const list = await h.api().get(`${API}/academic/years`).set(auth(o.ownerToken)).expect(200);
      const byId = new Map((list.body.data as any[]).map((y) => [y.id, y]));
      expect(byId.get(secondId).isCurrent).toBe(true);
      expect(byId.get(firstId).isCurrent).toBe(false);
      const current = await h.api().get(`${API}/academic/years/current`).set(auth(o.ownerToken)).expect(200);
      expect(current.body.data.id).toBe(secondId);
    });
  });

  test('an employee cannot author the academic calendar', ({ given, when, then }) => {
    let o: CreatedOrg;
    let emp: { token: string };
    let res: request.Response;
    given('an organization with an employee', async () => {
      o = await org();
      emp = await h.createEmployeeMember(o);
    });
    when('the employee tries to create an academic year', async () => {
      res = await createYear(o, yearBody(), emp.token);
    });
    then('the request is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  test("one org cannot see another org's academic years", ({ given, when, then }) => {
    let a: CreatedOrg;
    let b: CreatedOrg;
    let res: request.Response;
    given('two organizations that each have an academic year', async () => {
      a = await org();
      b = await org();
      await createYear(a, yearBody('A-year')).expect(201);
      await createYear(b, yearBody('B-year')).expect(201);
    });
    when("the first organization's owner lists academic years", async () => {
      res = await h.api().get(`${API}/academic/years`).set(auth(a.ownerToken)).expect(200);
    });
    then("only the first organization's academic years are returned", () => {
      const names = (res.body.data as any[]).map((y) => y.name);
      expect(names).toContain('A-year');
      expect(names).not.toContain('B-year');
    });
  });

  test('terms are created in order under a year', ({ given, when, then }) => {
    let o: CreatedOrg;
    let yearId: string;
    given('an organization with an academic year', async () => {
      o = await org();
      const y = await createYear(o, yearBody()).expect(201);
      yearId = y.body.data.id;
    });
    when('the owner adds two terms to that year', async () => {
      await h.api().post(`${API}/academic/years/${yearId}/terms`).set(auth(o.ownerToken))
        .send({ name: 'Term 1', startDate: '2025-06-01', endDate: '2025-09-30' }).expect(201);
      await h.api().post(`${API}/academic/years/${yearId}/terms`).set(auth(o.ownerToken))
        .send({ name: 'Term 2', startDate: '2025-10-01', endDate: '2026-01-31' }).expect(201);
    });
    then('the terms are listed in sequence order', async () => {
      const list = await h.api().get(`${API}/academic/years/${yearId}/terms`).set(auth(o.ownerToken)).expect(200);
      const rows = list.body.data as any[];
      expect(rows.map((t) => t.name)).toEqual(['Term 1', 'Term 2']);
      expect(rows.map((t) => t.sequence)).toEqual([1, 2]);
    });
  });

  test('a term outside the academic year is rejected', ({ given, when, then }) => {
    let o: CreatedOrg;
    let yearId: string;
    let res: request.Response;
    given('an organization with an academic year', async () => {
      o = await org();
      const y = await createYear(o, yearBody()).expect(201);
      yearId = y.body.data.id;
    });
    when('the owner adds a term dated outside the academic year', async () => {
      res = await h.api().post(`${API}/academic/years/${yearId}/terms`).set(auth(o.ownerToken))
        .send({ name: 'Bad', startDate: '2025-01-01', endDate: '2025-09-30' });
    });
    then('the request is rejected as a bad request', () => {
      expect(res.status).toBe(400);
    });
  });

  test('a new membership defaults to the staff person type', ({ given, when, then }) => {
    let o: CreatedOrg;
    let empUserId: string;
    let res: request.Response;
    given('an organization with an employee', async () => {
      o = await org();
      const emp = await h.createEmployeeMember(o);
      empUserId = emp.userId;
    });
    when('the owner lists the organization members', async () => {
      res = await h.api().get(`${API}/org/members`).set(auth(o.ownerToken)).expect(200);
    });
    then('every listed member is staff', async () => {
      // The employee is present in the directory ...
      const listed = (res.body.data as any[]).map((m) => m.userId);
      expect(listed).toContain(empUserId);
      // ... and every membership row backing the directory is personType 'staff'.
      const rows = await memberships.find({ where: { organizationId: o.orgId } });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((m) => m.personType === 'staff')).toBe(true);
    });
  });

  test('a student membership is excluded from the staff directory and seat count', ({ given, when, then, and }) => {
    let o: CreatedOrg;
    let studentUserId: string;
    let res: request.Response;
    given('an organization with an employee and a student membership', async () => {
      o = await org();
      await h.createEmployeeMember(o);
      // A raw student membership (as the future education vertical would create).
      studentUserId = newObjectId();
      h.trackUser(studentUserId);
      await memberships.save(
        memberships.create({
          organizationId: o.orgId,
          userId: studentUserId,
          email: `student+${studentUserId}@nugenova.test`,
          role: 'employee',
          status: 'active',
          personType: 'student',
        }),
      );
    });
    when('the owner lists the organization members', async () => {
      res = await h.api().get(`${API}/org/members`).set(auth(o.ownerToken)).expect(200);
    });
    then('the student does not appear in the member list', () => {
      const listed = (res.body.data as any[]).map((m) => m.userId);
      expect(listed).not.toContain(studentUserId);
    });
    and('the organization seat count excludes the student', async () => {
      // Seats are counted from ACTIVE STAFF only. The org has owner + 1 employee
      // = 2 staff seats; the student must not inflate that.
      const usage = await h.api().get(`${API}/admin/platform/usage`).set(auth(o.saToken)).expect(200);
      const row = (usage.body.data.perOrg as any[]).find((x) => x.id === o.orgId);
      expect(row).toBeDefined();
      expect(row.members).toBe(2);
    });
  });
});
