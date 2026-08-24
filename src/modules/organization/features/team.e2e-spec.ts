import { defineFeature, loadFeature } from 'jest-cucumber';
import request from 'supertest';

import {
  bootOrgTestApp,
  OrgTestHarness,
  CreatedOrg,
  randomEmail,
} from './support/org-harness';

const feature = loadFeature('./team.feature', { loadRelativePath: true });

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  beforeAll(async () => {
    h = await bootOrgTestApp();
  });
  afterAll(async () => {
    await h.cleanup();
  });

  const addMember = (token: string, body: any) =>
    h
      .api()
      .post('/api/v1/org/members')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const listMembers = (token: string) =>
    h.api().get('/api/v1/org/members').set('Authorization', `Bearer ${token}`);

  const createDept = (token: string, name: string) =>
    h
      .api()
      .post('/api/v1/org/departments')
      .set('Authorization', `Bearer ${token}`)
      .send({ name });

  test('an owner adds a member with a role and department', ({
    given,
    when,
    then,
    and,
  }) => {
    let org: CreatedOrg;
    let deptId: string;
    let email: string;
    let res: request.Response;

    given(
      'an organization owner with a department named "Engineering"',
      async () => {
        org = await h.createOrg();
        const dept = await createDept(org.ownerToken, 'Engineering').expect(201);
        deptId = dept.body.data.id;
      },
    );
    when('they add a member with the "manager" role in that department', async () => {
      email = randomEmail('member');
      res = await addMember(org.ownerToken, {
        email,
        role: 'manager',
        departmentId: deptId,
        firstName: 'Mem',
        lastName: 'Ber',
      });
      if (res.body?.data?.userId) h.trackUser(res.body.data.userId);
    });
    then('the member is created active with that role and department', () => {
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.membershipId).toBeTruthy();
      expect(res.body.data.email).toBe(email.toLowerCase());
      expect(res.body.data.role).toBe('manager');
      expect(res.body.data.departmentId).toBe(deptId);
      expect(res.body.data.status).toBe('active');
    });
    and('the new member appears in the team list', async () => {
      const list = await listMembers(org.ownerToken);
      const emails = list.body.data.map((m: any) => m.email);
      expect(emails).toContain(email.toLowerCase());
    });
  });

  test('the owner is included in the team list', ({ given, when, then }) => {
    let org: CreatedOrg;
    let res: request.Response;

    given('an organization owner', async () => {
      org = await h.createOrg();
    });
    when('they list team members', async () => {
      res = await listMembers(org.ownerToken);
    });
    then("the owner's own membership is in the list", () => {
      expect(res.status).toBe(200);
      const owner = res.body.data.find((m: any) => m.userId === org.ownerId);
      expect(owner).toBeDefined();
      expect(owner.role).toBe('owner');
    });
  });

  test('adding the same person twice is rejected', ({ given, when, then }) => {
    let org: CreatedOrg;
    let email: string;
    let res: request.Response;

    given('an organization owner who has added a member', async () => {
      org = await h.createOrg();
      email = randomEmail('member');
      const first = await addMember(org.ownerToken, { email }).expect(201);
      if (first.body?.data?.userId) h.trackUser(first.body.data.userId);
    });
    when('they add the same email again', async () => {
      res = await addMember(org.ownerToken, { email });
    });
    then('the member request is rejected as a conflict', () => {
      expect(res.status).toBe(409);
    });
  });

  test('an employee-tier member cannot add teammates', ({
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
    when('the employee tries to add a member', async () => {
      res = await addMember(empToken, { email: randomEmail('member') });
    });
    then('the member request is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  test("an owner cannot see another organization's members", ({
    given,
    and,
    when,
    then,
  }) => {
    let orgA: CreatedOrg;
    let orgB: CreatedOrg;
    let bMemberEmail: string;
    let res: request.Response;

    given('two organizations each owned by a different owner', async () => {
      orgA = await h.createOrg();
      orgB = await h.createOrg();
    });
    and("organization B's owner has added a member", async () => {
      bMemberEmail = randomEmail('bmember');
      const added = await addMember(orgB.ownerToken, {
        email: bMemberEmail,
      }).expect(201);
      if (added.body?.data?.userId) h.trackUser(added.body.data.userId);
    });
    when("organization A's owner lists team members", async () => {
      res = await listMembers(orgA.ownerToken);
    });
    then("organization B's member is not visible", () => {
      expect(res.status).toBe(200);
      const emails = res.body.data.map((m: any) => m.email);
      expect(emails).not.toContain(bMemberEmail.toLowerCase());
      const userIds = res.body.data.map((m: any) => m.userId);
      expect(userIds).not.toContain(orgB.ownerId);
    });
  });
});
