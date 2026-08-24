import { defineFeature, loadFeature } from 'jest-cucumber';
import request from 'supertest';

import {
  bootOnboardingApp,
  OnboardingHarness,
  OnboardingOrg,
  DEV_OTP,
} from './support/onboarding-harness';

const feature = loadFeature('./onboarding-gate.feature', {
  loadRelativePath: true,
});

defineFeature(feature, (test) => {
  let h: OnboardingHarness;
  beforeAll(async () => {
    h = await bootOnboardingApp();
  });
  afterAll(async () => {
    await h.cleanup();
  });

  const verify = (email: string) =>
    h.api().post('/api/v1/auth/verify-otp').send({ email, otp: DEV_OTP });

  const departments = (token: string) =>
    h.api().get('/api/v1/org/departments').set('Authorization', `Bearer ${token}`);

  test('the owner of an onboarding org is routed to onboarding', ({
    given,
    when,
    then,
  }) => {
    let org: OnboardingOrg;
    let res: request.Response;

    given('a super admin has provisioned an onboarding organization', async () => {
      org = await h.createOnboardingOrg();
    });
    when('the owner completes OTP verification', async () => {
      await h.api().post('/api/v1/auth/send-otp').send({ email: org.ownerEmail });
      res = await verify(org.ownerEmail);
    });
    then('the owner is routed to "/onboarding"', () => {
      expect(res.status).toBe(200);
      expect(res.body.data.route).toBe('/onboarding');
    });
  });

  test('the owner cannot reach the org-admin surface while onboarding', ({
    given,
    when,
    then,
  }) => {
    let org: OnboardingOrg;
    let res: request.Response;

    given('a super admin has provisioned an onboarding organization', async () => {
      org = await h.createOnboardingOrg();
    });
    when('the onboarding owner calls the departments endpoint', async () => {
      res = await departments(org.ownerToken);
    });
    then('the request is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  test('once every document is approved the owner reaches the dashboard', ({
    given,
    when,
    then,
    and,
  }) => {
    let org: OnboardingOrg;
    let res: request.Response;

    given(
      'an onboarding org whose only document has been approved',
      async () => {
        org = await h.createOnboardingOrg();
        const created = await h.requestDocs(org, {
          templateKeys: ['builtin_nda'],
        });
        const docId = created[0].id;
        await h
          .api()
          .post(`/api/v1/onboarding/documents/${docId}/submit`)
          .set('Authorization', `Bearer ${org.ownerToken}`)
          .send({ signerName: 'Olivia Owner', method: 'typed' });
        await h
          .api()
          .post(`/api/v1/admin/onboarding-documents/${docId}/approve`)
          .set('Authorization', `Bearer ${org.saToken}`)
          .send({});
      },
    );
    when('the owner completes OTP verification again', async () => {
      res = await verify(org.ownerEmail);
    });
    then('the owner is routed to "/dashboard"', () => {
      expect(res.status).toBe(200);
      expect(res.body.data.route).toBe('/dashboard');
    });
    and('the owner can now reach the departments endpoint', async () => {
      const token = res.body.data.accessToken;
      const dept = await departments(token);
      expect(dept.status).toBe(200);
    });
  });

  test('a non super admin cannot request documents for an org', ({
    given,
    when,
    then,
  }) => {
    let org: OnboardingOrg;
    let res: request.Response;

    given('a super admin has provisioned an onboarding organization', async () => {
      org = await h.createOnboardingOrg();
    });
    when('the owner tries to request documents for their own org', async () => {
      res = await h
        .api()
        .post(`/api/v1/admin/organizations/${org.orgId}/documents`)
        .set('Authorization', `Bearer ${org.ownerToken}`)
        .send({ templateKeys: ['builtin_nda'] });
    });
    then('the request is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  test('a non super admin cannot approve a document', ({
    given,
    when,
    then,
  }) => {
    let org: OnboardingOrg;
    let docId: string;
    let res: request.Response;

    given('an onboarding org with a signed, submitted document', async () => {
      org = await h.createOnboardingOrg();
      const created = await h.requestDocs(org, { templateKeys: ['builtin_nda'] });
      docId = created[0].id;
      await h
        .api()
        .post(`/api/v1/onboarding/documents/${docId}/submit`)
        .set('Authorization', `Bearer ${org.ownerToken}`)
        .send({ signerName: 'Olivia Owner', method: 'typed' });
    });
    when('the owner tries to approve that document', async () => {
      res = await h
        .api()
        .post(`/api/v1/admin/onboarding-documents/${docId}/approve`)
        .set('Authorization', `Bearer ${org.ownerToken}`)
        .send({});
    });
    then('the request is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  test('an unauthenticated caller cannot open the onboarding surface', ({
    when,
    then,
  }) => {
    let res: request.Response;

    when('an anonymous caller opens the onboarding surface', async () => {
      res = await h.api().get('/api/v1/onboarding');
    });
    then('the request is rejected as unauthorized', () => {
      expect(res.status).toBe(401);
    });
  });

  test("an owner cannot submit a document belonging to another org", ({
    given,
    when,
    then,
  }) => {
    let orgA: OnboardingOrg;
    let orgBDocId: string;
    let res: request.Response;

    given(
      'two separate onboarding orgs each with a document requested',
      async () => {
        orgA = await h.createOnboardingOrg();
        await h.requestDocs(orgA, { templateKeys: ['builtin_nda'] });
        const orgB = await h.createOnboardingOrg();
        const bDocs = await h.requestDocs(orgB, {
          templateKeys: ['builtin_nda'],
        });
        orgBDocId = bDocs[0].id;
      },
    );
    when("the first owner tries to submit the second org's document", async () => {
      res = await h
        .api()
        .post(`/api/v1/onboarding/documents/${orgBDocId}/submit`)
        .set('Authorization', `Bearer ${orgA.ownerToken}`)
        .send({ signerName: 'Olivia Owner', method: 'typed' });
    });
    then('the request is rejected as not found', () => {
      expect(res.status).toBe(404);
    });
  });
});
