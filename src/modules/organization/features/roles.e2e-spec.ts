import { defineFeature, loadFeature } from 'jest-cucumber';
import request from 'supertest';

import {
  bootOrgTestApp,
  OrgTestHarness,
  CreatedOrg,
} from './support/org-harness';

const feature = loadFeature('./roles.feature', { loadRelativePath: true });

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  beforeAll(async () => {
    h = await bootOrgTestApp();
  });
  afterAll(async () => {
    await h.cleanup();
  });

  const createRole = (token: string, body: any) =>
    h
      .api()
      .post('/api/v1/org/roles')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const listRoles = (token: string) =>
    h.api().get('/api/v1/org/roles').set('Authorization', `Bearer ${token}`);

  test('an owner creates a role with a permission matrix', ({
    given,
    when,
    then,
  }) => {
    let org: CreatedOrg;
    let res: request.Response;

    given('an organization owner', async () => {
      org = await h.createOrg();
    });
    when(
      'they create a role "Recruiter" that can read and write "candidates"',
      async () => {
        res = await createRole(org.ownerToken, {
          name: 'Recruiter',
          displayName: 'Recruiter',
          permissions: [
            { resource: 'candidates', actions: ['read', 'write'] },
          ],
        });
      },
    );
    then('the role is created with that permission matrix', () => {
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBeTruthy();
      expect(res.body.data.name).toBe('Recruiter');
      expect(res.body.data.organizationId).toBe(org.orgId);
      expect(res.body.data.permissions).toEqual([
        { resource: 'candidates', actions: ['read', 'write'] },
      ]);
    });
  });

  test('an owner lists their roles', ({ given, when, then }) => {
    let org: CreatedOrg;
    let res: request.Response;

    given('an organization owner with a role named "Auditor"', async () => {
      org = await h.createOrg();
      await createRole(org.ownerToken, { name: 'Auditor' }).expect(201);
    });
    when('they list roles', async () => {
      res = await listRoles(org.ownerToken);
    });
    then('"Auditor" is among the returned roles', () => {
      expect(res.status).toBe(200);
      const names = res.body.data.map((r: any) => r.name);
      expect(names).toContain('Auditor');
    });
  });

  test('duplicate role names in one org are rejected', ({
    given,
    when,
    then,
  }) => {
    let org: CreatedOrg;
    let res: request.Response;

    given('an organization owner with a role named "Manager+"', async () => {
      org = await h.createOrg();
      await createRole(org.ownerToken, { name: 'Manager+' }).expect(201);
    });
    when('they create another role named "Manager+"', async () => {
      res = await createRole(org.ownerToken, { name: 'Manager+' });
    });
    then('the role request is rejected as a conflict', () => {
      expect(res.status).toBe(409);
    });
  });

  test('an owner seeds the default roles', ({ given, when, then, and }) => {
    let org: CreatedOrg;
    let res: request.Response;

    const seed = (token: string) =>
      h
        .api()
        .post('/api/v1/org/roles/seed-defaults')
        .set('Authorization', `Bearer ${token}`);

    given('an organization owner', async () => {
      org = await h.createOrg();
    });
    when('they seed the default roles', async () => {
      res = await seed(org.ownerToken).expect(200);
    });
    then(
      '"HR Manager", "Developer" and "Designer" are among the returned roles',
      () => {
        const names = res.body.data.map((r: any) => r.displayName);
        expect(names).toEqual(
          expect.arrayContaining(['HR Manager', 'Developer', 'Designer']),
        );
      },
    );
    and('seeding again does not duplicate them', async () => {
      const before = res.body.data.length;
      const again = await seed(org.ownerToken).expect(200);
      expect(again.body.data.length).toBe(before);
    });
  });

  test('an employee-tier member cannot manage roles', ({
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
    when('the employee lists roles', async () => {
      res = await listRoles(empToken);
    });
    then('the role request is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });
});
