import { defineFeature, loadFeature } from 'jest-cucumber';
import request from 'supertest';

import {
  bootOrgTestApp,
  OrgTestHarness,
  CreatedOrg,
  randomEmail,
  randomOrgName,
} from './support/org-harness';
import { newObjectId } from '../../../bootstrap/database/object-id';

const feature = loadFeature('./org-provisioning.feature', {
  loadRelativePath: true,
});

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  beforeAll(async () => {
    h = await bootOrgTestApp();
  });
  afterAll(async () => {
    await h.cleanup();
  });

  test('a super admin provisions an organization and its owner', ({
    given,
    when,
    then,
    and,
  }) => {
    let token: string;
    let ownerEmail: string;
    let res: request.Response;

    given('a signed-in super admin', async () => {
      token = (await h.createSuperAdmin()).token;
    });
    when('they create an organization with a fresh owner email', async () => {
      ownerEmail = randomEmail('owner');
      const termsId = await h.createTerms(token);
      res = await h
        .api()
        .post('/api/v1/admin/organizations')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: randomOrgName(), ownerEmail, termsId });
      if (res.body?.data?.organization?.id) {
        h.trackOrg(res.body.data.organization.id);
      }
      if (res.body?.data?.owner?.id) h.trackUser(res.body.data.owner.id);
    });
    then(
      'the organization is created active but with consent pending, and a slug',
      () => {
        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        const org = res.body.data.organization;
        expect(org.id).toBeTruthy();
        expect(org.status).toBe('active');
        expect(org.needsConsent).toBe(true);
        expect(org.consentAccepted).toBe(false);
        expect(typeof org.slug).toBe('string');
        expect(org.slug.length).toBeGreaterThan(0);
        expect(org.ownerId).toBeTruthy();
      },
    );
    and('the response names the owner account', () => {
      expect(res.body.data.owner.email).toBe(ownerEmail.toLowerCase());
      expect(res.body.data.owner.id).toBe(res.body.data.organization.ownerId);
    });
  });

  test('the provisioned owner logs in scoped to the new org as owner', ({
    given,
    when,
    then,
    and,
  }) => {
    let org: CreatedOrg;
    let loginRes: request.Response;

    given(
      'a super admin has provisioned an organization for a fresh owner',
      async () => {
        org = await h.createOrg();
      },
    );
    when('the owner completes OTP verification', async () => {
      await h.api().post('/api/v1/auth/send-otp').send({ email: org.ownerEmail });
      loginRes = await h
        .api()
        .post('/api/v1/auth/verify-otp')
        .send({ email: org.ownerEmail, otp: '000000' });
    });
    then(
      'the owner is routed to "/setup" scoped to that organization',
      () => {
        expect(loginRes.status).toBe(200);
        // A consented owner who hasn't finished the setup wizard lands on /setup
        // (the setup gate), not /dashboard. Setup completion is covered elsewhere.
        expect(loginRes.body.data.route).toBe('/setup');
        expect(loginRes.body.data.organizationId).toBe(org.orgId);
      },
    );
    and('an owner token can reach the org admin surface', async () => {
      const res = await h
        .api()
        .get('/api/v1/org/departments')
        .set('Authorization', `Bearer ${org.ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  test('a super admin can list and fetch organizations', ({
    given,
    when,
    then,
    and,
  }) => {
    let saToken: string;
    let org: CreatedOrg;
    let listRes: request.Response;

    given('a super admin has provisioned an organization', async () => {
      const sa = await h.createSuperAdmin();
      saToken = sa.token;
      org = await h.createOrg();
    });
    when('the super admin lists organizations', async () => {
      listRes = await h
        .api()
        .get('/api/v1/admin/organizations')
        .set('Authorization', `Bearer ${saToken}`);
    });
    then('the created organization appears in the list', () => {
      expect(listRes.status).toBe(200);
      const ids = listRes.body.data.map((o: any) => o.id);
      expect(ids).toContain(org.orgId);
    });
    and('fetching it by id returns the same organization', async () => {
      const res = await h
        .api()
        .get(`/api/v1/admin/organizations/${org.orgId}`)
        .set('Authorization', `Bearer ${saToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(org.orgId);
    });
  });

  test('fetching a missing organization returns 404', ({ given, when, then }) => {
    let token: string;
    let res: request.Response;

    given('a signed-in super admin', async () => {
      token = (await h.createSuperAdmin()).token;
    });
    when('they fetch an organization id that does not exist', async () => {
      res = await h
        .api()
        .get(`/api/v1/admin/organizations/${newObjectId()}`)
        .set('Authorization', `Bearer ${token}`);
    });
    then('the provisioning request is rejected as not found', () => {
      expect(res.status).toBe(404);
    });
  });

  test('a non super admin cannot provision an organization', ({
    given,
    when,
    then,
  }) => {
    let token: string;
    let res: request.Response;

    given('a signed-in ordinary user who is not a platform admin', async () => {
      const email = randomEmail('user');
      const u = await h.users.save(
        h.users.create({
          email: email.toLowerCase(),
          password: 'pending-otp-' + newObjectId(),
          firstName: 'Ordinary',
          lastName: 'User',
          isActive: true,
          setupStage: 'complete',
          roles: ['user'],
          isPlatformAdmin: false,
        }),
      );
      h.trackUser(u.id);
      token = await h.mintToken(u.email);
    });
    when('they attempt to create an organization', async () => {
      res = await h
        .api()
        .post('/api/v1/admin/organizations')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: randomOrgName(), ownerEmail: randomEmail('owner') });
    });
    then('the provisioning request is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  test('an unauthenticated caller cannot provision an organization', ({
    when,
    then,
  }) => {
    let res: request.Response;

    when('an anonymous caller attempts to create an organization', async () => {
      res = await h
        .api()
        .post('/api/v1/admin/organizations')
        .send({ name: randomOrgName(), ownerEmail: randomEmail('owner') });
    });
    then('the provisioning request is rejected as unauthorized', () => {
      expect(res.status).toBe(401);
    });
  });
});
