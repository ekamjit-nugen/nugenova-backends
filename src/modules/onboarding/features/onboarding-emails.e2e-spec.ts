import { defineFeature, loadFeature } from 'jest-cucumber';

import {
  bootOnboardingApp,
  OnboardingHarness,
  OnboardingOrg,
} from './support/onboarding-harness';

const feature = loadFeature('./onboarding-emails.feature', {
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

  const emailsFor = (orgId: string, category: string) =>
    h.outbox.count({ where: { organizationId: orgId, category } });

  const sign = (org: OnboardingOrg, id: string) =>
    h
      .api()
      .post(`/api/v1/onboarding/documents/${id}/submit`)
      .set('Authorization', `Bearer ${org.ownerToken}`)
      .send({ signerName: 'Olivia Owner', method: 'typed' });

  const approve = (org: OnboardingOrg, id: string) =>
    h
      .api()
      .post(`/api/v1/admin/onboarding-documents/${id}/approve`)
      .set('Authorization', `Bearer ${org.saToken}`)
      .send({});

  test('requesting documents emails the owner a submission link', ({
    given,
    when,
    then,
  }) => {
    let org: OnboardingOrg;

    given('a super admin has provisioned an onboarding organization', async () => {
      org = await h.createOnboardingOrg();
    });
    when('the super admin requests documents with notification enabled', async () => {
      await h.requestDocs(org, {
        templateKeys: ['builtin_nda'],
        notify: true,
      });
    });
    then('a documents-requested email is recorded for the organization', async () => {
      const count = await emailsFor(
        org.orgId,
        'onboarding.documents_requested',
      );
      expect(count).toBeGreaterThanOrEqual(1);
    });
  });

  test('approving a non-final document emails the owner', ({
    given,
    when,
    then,
  }) => {
    let org: OnboardingOrg;
    let firstId: string;

    given(
      'an onboarding org with two documents, one signed and submitted',
      async () => {
        org = await h.createOnboardingOrg();
        const created = await h.requestDocs(org, {
          templateKeys: ['builtin_nda', 'builtin_incorporation_certificate'],
        });
        firstId = created[0].id;
        await sign(org, firstId);
      },
    );
    when('the super admin approves that document', async () => {
      await approve(org, firstId);
    });
    then('a document-approved email is recorded for the organization', async () => {
      const count = await emailsFor(org.orgId, 'onboarding.document_approved');
      expect(count).toBeGreaterThanOrEqual(1);
    });
  });

  test('rejecting a document emails the owner the reason', ({
    given,
    when,
    then,
  }) => {
    let org: OnboardingOrg;
    let docId: string;

    given('an onboarding org with a signed, submitted document', async () => {
      org = await h.createOnboardingOrg();
      const created = await h.requestDocs(org, { templateKeys: ['builtin_nda'] });
      docId = created[0].id;
      await sign(org, docId);
    });
    when('the super admin rejects the document with a reason', async () => {
      await h
        .api()
        .post(`/api/v1/admin/onboarding-documents/${docId}/reject`)
        .set('Authorization', `Bearer ${org.saToken}`)
        .send({ note: 'Please provide a clearer copy' });
    });
    then('a document-rejected email is recorded for the organization', async () => {
      const count = await emailsFor(org.orgId, 'onboarding.document_rejected');
      expect(count).toBeGreaterThanOrEqual(1);
    });
  });

  test('activating the organization emails the owner a welcome', ({
    given,
    when,
    then,
  }) => {
    let org: OnboardingOrg;
    let docId: string;

    given(
      'an onboarding org whose only document has been submitted',
      async () => {
        org = await h.createOnboardingOrg();
        const created = await h.requestDocs(org, {
          templateKeys: ['builtin_nda'],
        });
        docId = created[0].id;
        await sign(org, docId);
      },
    );
    when('the super admin approves that final document', async () => {
      await approve(org, docId);
    });
    then('an organization-activated email is recorded for the organization', async () => {
      const count = await emailsFor(org.orgId, 'onboarding.org_activated');
      expect(count).toBeGreaterThanOrEqual(1);
    });
  });
});
