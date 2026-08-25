import { defineFeature, loadFeature } from 'jest-cucumber';
import request from 'supertest';

import {
  bootOrgTestApp,
  OrgTestHarness,
  CreatedOrg,
  randomEmail,
} from './support/org-harness';

const feature = loadFeature('./rbac.feature', { loadRelativePath: true });

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  beforeAll(async () => {
    h = await bootOrgTestApp();
  });
  afterAll(async () => {
    await h.cleanup();
  });

  /** Owner creates a departments:view role, assigns it to a fresh member, and
   *  returns that member's (permScoped) token. */
  const setupDeptViewer = async (org: CreatedOrg): Promise<string> => {
    const role = await h
      .api()
      .post('/api/v1/org/roles')
      .set('Authorization', `Bearer ${org.ownerToken}`)
      .send({
        name: 'dept_viewer',
        displayName: 'Dept Viewer',
        permissions: [{ resource: 'departments', actions: ['view'] }],
      })
      .expect(201);
    const roleId = role.body.data.id;

    const email = randomEmail('scoped');
    const member = await h
      .api()
      .post('/api/v1/org/members')
      .set('Authorization', `Bearer ${org.ownerToken}`)
      .send({ email, roleId, firstName: 'Scoped', lastName: 'Member' })
      .expect(201);
    h.trackUser(member.body.data.userId);

    // The minted token folds the role's matrix into the JWT (permScoped).
    return h.mintToken(email);
  };

  test('a permScoped member can read a resource their role grants', ({
    given,
    and,
    when,
    then,
  }) => {
    let org: CreatedOrg;
    let memberToken: string;
    let res: request.Response;

    given(
      'an organization owner who created a "Dept Viewer" role granting departments:view',
      async () => {
        org = await h.createOrg();
      },
    );
    and('a member assigned that role', async () => {
      memberToken = await setupDeptViewer(org);
    });
    when('the member lists departments', async () => {
      res = await h
        .api()
        .get('/api/v1/org/departments')
        .set('Authorization', `Bearer ${memberToken}`);
    });
    then('the request succeeds', () => {
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  test('a permScoped member is denied a resource their role does not grant', ({
    given,
    and,
    when,
    then,
  }) => {
    let org: CreatedOrg;
    let memberToken: string;
    let res: request.Response;

    given(
      'an organization owner who created a "Dept Viewer" role granting departments:view',
      async () => {
        org = await h.createOrg();
      },
    );
    and('a member assigned that role', async () => {
      memberToken = await setupDeptViewer(org);
    });
    when('the member lists roles', async () => {
      res = await h
        .api()
        .get('/api/v1/org/roles')
        .set('Authorization', `Bearer ${memberToken}`);
    });
    then('the request is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  test('a permScoped member is denied an action their role does not grant', ({
    given,
    and,
    when,
    then,
  }) => {
    let org: CreatedOrg;
    let memberToken: string;
    let res: request.Response;

    given(
      'an organization owner who created a "Dept Viewer" role granting departments:view',
      async () => {
        org = await h.createOrg();
      },
    );
    and('a member assigned that role', async () => {
      memberToken = await setupDeptViewer(org);
    });
    when('the member tries to create a department', async () => {
      res = await h
        .api()
        .post('/api/v1/org/departments')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ name: 'Sneaky Dept', code: 'SNK' });
    });
    then('the request is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  test("the platform super admin cannot read an org's org-scoped data", ({
    given,
    when,
    then,
  }) => {
    let depRes: request.Response;
    let rolRes: request.Response;

    given('an organization owner', async () => {
      await h.createOrg(); // an org with data exists
    });
    when("the platform super admin requests that org's departments and roles", async () => {
      // A super admin is NOT an org member — /org/* must be closed to them
      // (they manage tenants via /admin/*). This is the cross-org isolation gate.
      const sa = await h.createSuperAdmin();
      depRes = await h
        .api()
        .get('/api/v1/org/departments')
        .set('Authorization', `Bearer ${sa.token}`);
      rolRes = await h
        .api()
        .get('/api/v1/org/roles')
        .set('Authorization', `Bearer ${sa.token}`);
    });
    then('both requests are rejected as forbidden', () => {
      expect(depRes.status).toBe(403);
      expect(rolRes.status).toBe(403);
    });
  });
});
