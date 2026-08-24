import { defineFeature, loadFeature } from 'jest-cucumber';
import request from 'supertest';

import {
  bootOrgTestApp,
  OrgTestHarness,
  CreatedOrg,
} from './support/org-harness';

const feature = loadFeature('./departments.feature', { loadRelativePath: true });

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  beforeAll(async () => {
    h = await bootOrgTestApp();
  });
  afterAll(async () => {
    await h.cleanup();
  });

  const createDept = (token: string, name: string, body: any = {}) =>
    h
      .api()
      .post('/api/v1/org/departments')
      .set('Authorization', `Bearer ${token}`)
      .send({ name, ...body });

  const listDepts = (token: string) =>
    h
      .api()
      .get('/api/v1/org/departments')
      .set('Authorization', `Bearer ${token}`);

  test('an owner creates a department', ({ given, when, then }) => {
    let org: CreatedOrg;
    let res: request.Response;

    given('an organization owner', async () => {
      org = await h.createOrg();
    });
    when('they create a department named "Engineering"', async () => {
      res = await createDept(org.ownerToken, 'Engineering');
    });
    then('the department is created under their organization', () => {
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBeTruthy();
      expect(res.body.data.name).toBe('Engineering');
      expect(res.body.data.organizationId).toBe(org.orgId);
      expect(res.body.data.isDeleted).toBe(false);
    });
  });

  test('an owner lists their departments', ({ given, when, then }) => {
    let org: CreatedOrg;
    let res: request.Response;

    given('an organization owner with a department named "Sales"', async () => {
      org = await h.createOrg();
      await createDept(org.ownerToken, 'Sales').expect(201);
    });
    when('they list departments', async () => {
      res = await listDepts(org.ownerToken);
    });
    then('"Sales" is among the returned departments', () => {
      expect(res.status).toBe(200);
      const names = res.body.data.map((d: any) => d.name);
      expect(names).toContain('Sales');
    });
  });

  test('an owner updates a department', ({ given, when, then }) => {
    let org: CreatedOrg;
    let deptId: string;
    let res: request.Response;

    given('an organization owner with a department named "Support"', async () => {
      org = await h.createOrg();
      const created = await createDept(org.ownerToken, 'Support').expect(201);
      deptId = created.body.data.id;
    });
    when('they rename it to "Customer Support"', async () => {
      res = await h
        .api()
        .put(`/api/v1/org/departments/${deptId}`)
        .set('Authorization', `Bearer ${org.ownerToken}`)
        .send({ name: 'Customer Support' });
    });
    then('the department reads back as "Customer Support"', async () => {
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Customer Support');
      const list = await listDepts(org.ownerToken);
      const names = list.body.data.map((d: any) => d.name);
      expect(names).toContain('Customer Support');
      expect(names).not.toContain('Support');
    });
  });

  test('an owner soft-deletes a department', ({ given, when, then }) => {
    let org: CreatedOrg;
    let deptId: string;

    given('an organization owner with a department named "Legacy"', async () => {
      org = await h.createOrg();
      const created = await createDept(org.ownerToken, 'Legacy').expect(201);
      deptId = created.body.data.id;
    });
    when('they delete that department', async () => {
      await h
        .api()
        .delete(`/api/v1/org/departments/${deptId}`)
        .set('Authorization', `Bearer ${org.ownerToken}`)
        .expect(200);
    });
    then('it no longer appears in the department list', async () => {
      const list = await listDepts(org.ownerToken);
      const ids = list.body.data.map((d: any) => d.id);
      expect(ids).not.toContain(deptId);
    });
  });

  test('duplicate department names in one org are rejected', ({
    given,
    when,
    then,
  }) => {
    let org: CreatedOrg;
    let res: request.Response;

    given('an organization owner with a department named "Finance"', async () => {
      org = await h.createOrg();
      await createDept(org.ownerToken, 'Finance').expect(201);
    });
    when('they create another department named "Finance"', async () => {
      res = await createDept(org.ownerToken, 'Finance');
    });
    then('the department request is rejected as a conflict', () => {
      expect(res.status).toBe(409);
    });
  });

  test('an employee-tier member cannot manage departments', ({
    given,
    when,
    then,
  }) => {
    let empToken: string;
    let res: request.Response;

    given('an employee-tier member of an organization', async () => {
      const org = await h.createOrg();
      empToken = (await h.createEmployeeMember(org)).token;
    });
    when('the employee lists departments', async () => {
      res = await listDepts(empToken);
    });
    then('the department request is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  test("an owner cannot see another organization's departments", ({
    given,
    and,
    when,
    then,
  }) => {
    let orgA: CreatedOrg;
    let orgB: CreatedOrg;
    let res: request.Response;

    given('two organizations each owned by a different owner', async () => {
      orgA = await h.createOrg();
      orgB = await h.createOrg();
    });
    and('organization B has a department named "Secret-B"', async () => {
      await createDept(orgB.ownerToken, 'Secret-B').expect(201);
    });
    when("organization A's owner lists departments", async () => {
      res = await listDepts(orgA.ownerToken);
    });
    then("organization B's department is not visible", () => {
      expect(res.status).toBe(200);
      const names = res.body.data.map((d: any) => d.name);
      expect(names).not.toContain('Secret-B');
      for (const d of res.body.data) {
        expect(d.organizationId).toBe(orgA.orgId);
      }
    });
  });
});
