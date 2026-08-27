import { defineFeature, loadFeature } from 'jest-cucumber';
import request from 'supertest';

import { bootOrgTestApp, OrgTestHarness, CreatedOrg } from './support/org-harness';

const feature = loadFeature('./consent.feature', { loadRelativePath: true });

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  beforeAll(async () => {
    h = await bootOrgTestApp();
  });
  afterAll(async () => {
    await h.cleanup();
  });

  const verify = (email: string) =>
    h.api().post('/api/v1/auth/verify-otp').send({ email, otp: '000000' });

  const departments = (token: string) =>
    h
      .api()
      .get('/api/v1/org/departments')
      .set('Authorization', `Bearer ${token}`);

  // Edit the org's ASSIGNED T&C (bumps its version → the org must re-accept).
  const editTerms = (org: CreatedOrg, text: string) =>
    h
      .api()
      .put(`/api/v1/admin/terms/${org.termsId}`)
      .set('Authorization', `Bearer ${org.saToken}`)
      .send({ title: 'Updated Terms', text });

  const SAMPLE_PDF = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF',
  );

  // Replace the org's assigned T&C with a PDF (also bumps its version).
  const publishPdfTerms = (org: CreatedOrg) =>
    h
      .api()
      .put(`/api/v1/admin/terms/${org.termsId}/pdf`)
      .set('Authorization', `Bearer ${org.saToken}`)
      .field('title', 'Signed Master Agreement')
      .attach('file', SAMPLE_PDF, {
        filename: 'terms.pdf',
        contentType: 'application/pdf',
      });

  const halt = (org: CreatedOrg) =>
    h
      .api()
      .post(`/api/v1/admin/organizations/${org.orgId}/halt`)
      .set('Authorization', `Bearer ${org.saToken}`)
      .send({});

  test('the owner of a new organization is routed to consent', ({
    given,
    when,
    then,
  }) => {
    let org: CreatedOrg;
    let res: request.Response;

    given('a super admin has provisioned an organization for a fresh owner', async () => {
      org = await h.provisionOrg();
    });
    when('the owner completes OTP verification', async () => {
      res = await verify(org.ownerEmail);
    });
    then('the owner is routed to "/consent"', () => {
      expect(res.status).toBe(200);
      expect(res.body.data.route).toBe('/consent');
    });
  });

  test('an unconsented owner is blocked from the org-admin surface', ({
    given,
    when,
    then,
  }) => {
    let org: CreatedOrg;
    let res: request.Response;

    given('a super admin has provisioned an organization for a fresh owner', async () => {
      org = await h.provisionOrg();
    });
    when('the unconsented owner calls the departments endpoint', async () => {
      res = await departments(org.ownerToken);
    });
    then('the request is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  test('accepting the terms unlocks the app', ({ given, when, then, and }) => {
    let org: CreatedOrg;

    given('a super admin has provisioned an organization for a fresh owner', async () => {
      org = await h.provisionOrg();
    });
    when('the owner accepts the Terms and Conditions', async () => {
      await h.acceptConsent(org);
    });
    then('the owner can reach the departments endpoint', async () => {
      const res = await departments(org.ownerToken);
      expect(res.status).toBe(200);
    });
    and('logging in again routes the owner to "/setup"', async () => {
      const res = await verify(org.ownerEmail);
      expect(res.body.data.route).toBe('/setup');
    });
  });

  test('the consent screen returns the current terms', ({
    given,
    when,
    then,
    and,
  }) => {
    let org: CreatedOrg;
    let res: request.Response;

    given('a super admin has provisioned an organization for a fresh owner', async () => {
      org = await h.provisionOrg();
    });
    when('the owner opens the consent screen', async () => {
      res = await h
        .api()
        .get('/api/v1/consent')
        .set('Authorization', `Bearer ${org.ownerToken}`);
    });
    then('it returns the current terms text and version', () => {
      expect(res.status).toBe(200);
      expect(typeof res.body.data.terms.text).toBe('string');
      expect(res.body.data.terms.text.length).toBeGreaterThan(0);
      expect(res.body.data.terms.version).toBeGreaterThanOrEqual(1);
    });
    and('it reports consent as not yet accepted', () => {
      expect(res.body.data.accepted).toBe(false);
      expect(res.body.data.needsConsent).toBe(true);
    });
  });

  test('the editor offers multiple terms templates', ({ given, when, then }) => {
    let org: CreatedOrg;
    let res: request.Response;

    given('a super admin has provisioned an organization for a fresh owner', async () => {
      org = await h.provisionOrg();
    });
    when('the super admin lists the terms templates', async () => {
      res = await h
        .api()
        .get('/api/v1/admin/terms/templates')
        .set('Authorization', `Bearer ${org.saToken}`);
    });
    then('more than one template is returned', () => {
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(1);
      expect(res.body.data[0]).toHaveProperty('id');
      expect(res.body.data[0]).toHaveProperty('html');
    });
  });

  test('publishing a PDF makes the org read and accept the document', ({
    given,
    when,
    then,
    and,
  }) => {
    let org: CreatedOrg;

    given('an organization that has accepted the current terms', async () => {
      org = await h.provisionOrg();
      await h.acceptConsent(org);
      expect((await departments(org.ownerToken)).status).toBe(200);
    });
    when('the super admin publishes a PDF as the new terms', async () => {
      const res = await publishPdfTerms(org);
      expect(res.status).toBe(200);
      expect(res.body.data.kind).toBe('pdf');
    });
    then('the consent screen reports a PDF document to read', async () => {
      const res = await h
        .api()
        .get('/api/v1/consent')
        .set('Authorization', `Bearer ${org.ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.terms.kind).toBe('pdf');
      expect(res.body.data.terms.hasDocument).toBe(true);
      expect(res.body.data.needsConsent).toBe(true);
    });
    and('the owner can download the current terms PDF', async () => {
      const res = await h
        .api()
        .get('/api/v1/consent/document')
        .set('Authorization', `Bearer ${org.ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
    });
    and('after re-accepting, the owner can reach the departments endpoint', async () => {
      // Stale consent (new version) blocks until re-accept.
      expect((await departments(org.ownerToken)).status).toBe(403);
      await h.acceptConsent(org);
      expect((await departments(org.ownerToken)).status).toBe(200);
    });
  });

  test('editing the terms forces the org to re-accept', ({
    given,
    when,
    then,
  }) => {
    let org: CreatedOrg;

    given('an organization that has accepted the current terms', async () => {
      org = await h.provisionOrg();
      await h.acceptConsent(org);
      expect((await departments(org.ownerToken)).status).toBe(200);
    });
    when('the super admin publishes a new version of the terms', async () => {
      const res = await editTerms(
        org,
        '<h2>Updated Terms</h2><p>Please re-accept.</p>',
      );
      expect(res.status).toBe(200);
    });
    then(
      'the owner is blocked from the departments endpoint until they re-accept',
      async () => {
        // Stale consent → blocked.
        expect((await departments(org.ownerToken)).status).toBe(403);
        // Re-accept the new version → unblocked.
        await h.acceptConsent(org);
        expect((await departments(org.ownerToken)).status).toBe(200);
      },
    );
  });

  test('a Terms and Conditions assigned to an org cannot be deleted', ({
    given,
    when,
    then,
  }) => {
    let org: CreatedOrg;
    let res: request.Response;

    given('an organization that has accepted the current terms', async () => {
      org = await h.provisionOrg();
      await h.acceptConsent(org);
    });
    when('the super admin tries to delete the assigned Terms and Conditions', async () => {
      res = await h
        .api()
        .delete(`/api/v1/admin/terms/${org.termsId}`)
        .set('Authorization', `Bearer ${org.saToken}`);
    });
    then('the request is rejected as a conflict', () => {
      expect(res.status).toBe(409);
    });
  });

  test('a super admin halts an organization', ({ given, when, then, and }) => {
    let org: CreatedOrg;

    given('an organization that has accepted the current terms', async () => {
      org = await h.provisionOrg();
      await h.acceptConsent(org);
    });
    when('the super admin halts the organization', async () => {
      expect((await halt(org)).status).toBe(200);
    });
    then('the owner is routed to "/suspended"', async () => {
      const res = await verify(org.ownerEmail);
      expect(res.body.data.route).toBe('/suspended');
    });
    and('the halted owner is blocked from the departments endpoint', async () => {
      expect((await departments(org.ownerToken)).status).toBe(403);
    });
  });

  test('a super admin reactivates a halted organization', ({
    given,
    when,
    then,
  }) => {
    let org: CreatedOrg;

    given('a halted organization', async () => {
      org = await h.provisionOrg();
      await h.acceptConsent(org);
      await halt(org);
    });
    when('the super admin reactivates it', async () => {
      const res = await h
        .api()
        .post(`/api/v1/admin/organizations/${org.orgId}/reactivate`)
        .set('Authorization', `Bearer ${org.saToken}`)
        .send({});
      expect(res.status).toBe(200);
    });
    then('the owner can reach the departments endpoint again', async () => {
      expect((await departments(org.ownerToken)).status).toBe(200);
    });
  });

  test('a non super admin cannot edit the terms', ({ given, when, then }) => {
    let org: CreatedOrg;
    let res: request.Response;

    given('a super admin has provisioned an organization for a fresh owner', async () => {
      org = await h.provisionOrg();
    });
    when('the owner tries to publish new terms', async () => {
      res = await h
        .api()
        .post('/api/v1/admin/terms')
        .set('Authorization', `Bearer ${org.ownerToken}`)
        .send({ title: 'Hacked', text: '<p>hacked terms</p>' });
    });
    then('the request is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  test('a non super admin cannot halt an organization', ({
    given,
    when,
    then,
  }) => {
    let org: CreatedOrg;
    let res: request.Response;

    given('a super admin has provisioned an organization for a fresh owner', async () => {
      org = await h.provisionOrg();
    });
    when('the owner tries to halt their own organization', async () => {
      res = await h
        .api()
        .post(`/api/v1/admin/organizations/${org.orgId}/halt`)
        .set('Authorization', `Bearer ${org.ownerToken}`)
        .send({});
    });
    then('the request is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });
});
