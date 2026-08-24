import { defineFeature, loadFeature } from 'jest-cucumber';
import request from 'supertest';

import {
  bootOnboardingApp,
  OnboardingHarness,
  OnboardingOrg,
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
        .send({ customDocuments: [{ title: 'Service Agreement', category: 'agreement', requiresSignature: true, bodyHtml: '<p>sign</p>' }] });
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
      const created = await h.requestDocs(org, { customDocuments: [{ title: 'Service Agreement', category: 'agreement', requiresSignature: true, bodyHtml: '<p>sign</p>' }] });
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
        await h.requestDocs(orgA, { customDocuments: [{ title: 'Service Agreement', category: 'agreement', requiresSignature: true, bodyHtml: '<p>sign</p>' }] });
        const orgB = await h.createOnboardingOrg();
        const bDocs = await h.requestDocs(orgB, {
          customDocuments: [{ title: 'Service Agreement', category: 'agreement', requiresSignature: true, bodyHtml: '<p>sign</p>' }],
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
