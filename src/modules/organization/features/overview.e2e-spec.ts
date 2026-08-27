import { defineFeature, loadFeature } from 'jest-cucumber';
import request from 'supertest';

import {
  bootOrgTestApp,
  OrgTestHarness,
  CreatedOrg,
  randomEmail,
} from './support/org-harness';

const feature = loadFeature('./overview.feature', { loadRelativePath: true });

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  beforeAll(async () => {
    h = await bootOrgTestApp();
  });
  afterAll(async () => {
    await h.cleanup();
  });

  const overview = (token: string) =>
    h.api().get('/api/v1/org/overview').set('Authorization', `Bearer ${token}`);

  test('overview reflects the created entities and counts', ({
    given,
    and,
    when,
    then,
  }) => {
    let org: CreatedOrg;
    let deptId: string;
    let roleId: string;
    let memberEmail: string;
    let res: request.Response;

    given('an organization owner', async () => {
      org = await h.createOrg();
    });
    and(
      'they have created a department, a role, and added a member',
      async () => {
        const dept = await h
          .api()
          .post('/api/v1/org/departments')
          .set('Authorization', `Bearer ${org.ownerToken}`)
          .send({ name: 'Engineering' })
          .expect(201);
        deptId = dept.body.data.id;

        const role = await h
          .api()
          .post('/api/v1/org/roles')
          .set('Authorization', `Bearer ${org.ownerToken}`)
          .send({ name: 'Reviewer' })
          .expect(201);
        roleId = role.body.data.id;

        memberEmail = randomEmail('member');
        const member = await h
          .api()
          .post('/api/v1/org/members')
          .set('Authorization', `Bearer ${org.ownerToken}`)
          .send({ email: memberEmail, role: 'employee', departmentId: deptId })
          .expect(201);
        h.trackUser(member.body.data.userId);
      },
    );
    when('they request the organization overview', async () => {
      res = await overview(org.ownerToken);
    });
    then(
      'the overview counts one department and two people, and its roles include the new one',
      () => {
        expect(res.status).toBe(200);
        expect(res.body.data.organizationId).toBe(org.orgId);
        expect(res.body.data.counts.departments).toBe(1);
        // owner + the added member.
        expect(res.body.data.counts.people).toBe(2);
        // The org seeds its tier roles (owner/admin/manager/… + defaults) at
        // creation, so the count is the full role list, not just the one made
        // here — assert it stays consistent with the payload and includes ours.
        expect(res.body.data.counts.roles).toBe(res.body.data.roles.length);
        expect(res.body.data.counts.roles).toBeGreaterThan(1);
        expect(res.body.data.roles.map((r: any) => r.id)).toContain(roleId);
      },
    );
    and('the overview lists the created department, role, and people', () => {
      const deptIds = res.body.data.departments.map((d: any) => d.id);
      expect(deptIds).toContain(deptId);
      const roleIds = res.body.data.roles.map((r: any) => r.id);
      expect(roleIds).toContain(roleId);
      const emails = res.body.data.people.map((p: any) => p.email);
      expect(emails).toContain(memberEmail.toLowerCase());
      expect(emails).toContain(org.ownerEmail.toLowerCase());
    });
  });

  test('an employee-tier member cannot read the overview', ({
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
    when('the employee requests the organization overview', async () => {
      res = await overview(empToken);
    });
    then('the overview request is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });
});
