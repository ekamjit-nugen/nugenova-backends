import { defineFeature, loadFeature } from 'jest-cucumber';
import request from 'supertest';

import {
  bootOnboardingApp,
  OnboardingHarness,
  OnboardingOrg,
} from './support/onboarding-harness';

const feature = loadFeature('./onboarding-lifecycle.feature', {
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

  const submit = (org: OnboardingOrg, id: string, body: any) =>
    h
      .api()
      .post(`/api/v1/onboarding/documents/${id}/submit`)
      .set('Authorization', `Bearer ${org.ownerToken}`)
      .send(body);

  const approve = (org: OnboardingOrg, id: string, note?: string) =>
    h
      .api()
      .post(`/api/v1/admin/onboarding-documents/${id}/approve`)
      .set('Authorization', `Bearer ${org.saToken}`)
      .send({ note });

  const reject = (org: OnboardingOrg, id: string, note: string) =>
    h
      .api()
      .post(`/api/v1/admin/onboarding-documents/${id}/reject`)
      .set('Authorization', `Bearer ${org.saToken}`)
      .send({ note });

  test('a super admin requests documents from an onboarding org', ({
    given,
    when,
    then,
    and,
  }) => {
    let org: OnboardingOrg;
    let created: any[];

    given('a super admin has provisioned an onboarding organization', async () => {
      org = await h.createOnboardingOrg();
    });
    when(
      'the super admin requests an agreement and an incorporation certificate',
      async () => {
        created = await h.requestDocs(org, {
          customDocuments: [
            { title: 'Service Agreement', category: 'agreement', requiresSignature: true, bodyHtml: '<p>sign</p>' },
            { title: 'Certificate of Incorporation', category: 'registration', requiresUpload: true },
          ],
        });
      },
    );
    then('two documents are created for the organization', () => {
      expect(created).toHaveLength(2);
    });
    and('each requested document starts in the requested state', () => {
      expect(created.every((d) => d.status === 'requested')).toBe(true);
    });
  });

  test('requesting a document already requested for an org is skipped', ({
    given,
    when,
    then,
  }) => {
    let org: OnboardingOrg;
    let res: request.Response;

    given(
      'an onboarding org already has an incorporation certificate requested',
      async () => {
        org = await h.createOnboardingOrg();
        await h.requestDocs(org, {
          templateKeys: ['builtin_incorporation_certificate'],
        });
      },
    );
    when('the super admin requests the incorporation certificate again', async () => {
      res = await h
        .api()
        .post(`/api/v1/admin/organizations/${org.orgId}/documents`)
        .set('Authorization', `Bearer ${org.saToken}`)
        .send({ templateKeys: ['builtin_incorporation_certificate'] });
    });
    then('no new document is created and it is reported as skipped', () => {
      expect(res.status).toBe(201);
      expect(res.body.data.count).toBe(0);
      expect(res.body.data.skipped).toHaveLength(1);
    });
  });

  test('the owner sees the requested documents as a checklist', ({
    given,
    when,
    then,
    and,
  }) => {
    let org: OnboardingOrg;
    let res: request.Response;

    given('an onboarding org has two documents requested', async () => {
      org = await h.createOnboardingOrg();
      await h.requestDocs(org, {
        customDocuments: [
            { title: 'Service Agreement', category: 'agreement', requiresSignature: true, bodyHtml: '<p>sign</p>' },
            { title: 'Certificate of Incorporation', category: 'registration', requiresUpload: true },
          ],
      });
    });
    when('the owner opens their onboarding checklist', async () => {
      res = await h
        .api()
        .get('/api/v1/onboarding')
        .set('Authorization', `Bearer ${org.ownerToken}`);
    });
    then('the owner sees both requested documents', () => {
      expect(res.status).toBe(200);
      expect(res.body.data.documents).toHaveLength(2);
    });
    and('the onboarding summary reports none approved yet', () => {
      expect(res.body.data.summary.approved).toBe(0);
      expect(res.body.data.summary.allApproved).toBe(false);
    });
  });

  test('the owner signs a signature document by typing their name', ({
    given,
    when,
    then,
    and,
  }) => {
    let org: OnboardingOrg;
    let res: request.Response;

    given(
      'an onboarding org with a signature document requested',
      async () => {
        org = await h.createOnboardingOrg();
        await h.requestDocs(org, { customDocuments: [{ title: 'Service Agreement', category: 'agreement', requiresSignature: true, bodyHtml: '<p>sign</p>' }] });
      },
    );
    when('the owner signs it with a typed signature', async () => {
      const list = await h
        .api()
        .get('/api/v1/onboarding')
        .set('Authorization', `Bearer ${org.ownerToken}`);
      const doc = list.body.data.documents[0];
      res = await submit(org, doc.id, {
        signerName: 'Olivia Owner',
        method: 'typed',
      });
    });
    then('the document moves to the submitted state', () => {
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('submitted');
    });
    and('the stored signature records the signer name and typed method', () => {
      expect(res.body.data.signature.signerName).toBe('Olivia Owner');
      expect(res.body.data.signature.method).toBe('typed');
    });
  });

  test('the owner uploads a required document', ({ given, and, when, then }) => {
    let org: OnboardingOrg;
    let docId: string;
    let fileId: string;
    let res: request.Response;

    given('an onboarding org with an upload document requested', async () => {
      org = await h.createOnboardingOrg();
      const created = await h.requestDocs(org, {
        templateKeys: ['builtin_incorporation_certificate'],
      });
      docId = created[0].id;
    });
    and('the owner has uploaded a file', async () => {
      const up = await h
        .api()
        .post('/api/v1/media/upload')
        .set('Authorization', `Bearer ${org.ownerToken}`)
        .attach('file', Buffer.from('%PDF-1.4 fake'), {
          filename: 'cert.pdf',
          contentType: 'application/pdf',
        });
      expect(up.status).toBe(201);
      fileId = up.body.data.id;
    });
    when('the owner submits the upload document with that file', async () => {
      res = await submit(org, docId, { submittedFileId: fileId });
    });
    then('the document moves to the submitted state', () => {
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('submitted');
    });
  });

  test('signing without a signer name is rejected', ({
    given,
    when,
    then,
  }) => {
    let org: OnboardingOrg;
    let docId: string;
    let res: request.Response;

    given(
      'an onboarding org with a signature document requested',
      async () => {
        org = await h.createOnboardingOrg();
        const created = await h.requestDocs(org, {
          customDocuments: [{ title: 'Service Agreement', category: 'agreement', requiresSignature: true, bodyHtml: '<p>sign</p>' }],
        });
        docId = created[0].id;
      },
    );
    when('the owner tries to sign it without a name', async () => {
      res = await submit(org, docId, { method: 'typed' });
    });
    then('the submission is rejected as a bad request', () => {
      expect(res.status).toBe(400);
    });
  });

  test('submitting an upload document without a file is rejected', ({
    given,
    when,
    then,
  }) => {
    let org: OnboardingOrg;
    let docId: string;
    let res: request.Response;

    given('an onboarding org with an upload document requested', async () => {
      org = await h.createOnboardingOrg();
      const created = await h.requestDocs(org, {
        templateKeys: ['builtin_incorporation_certificate'],
      });
      docId = created[0].id;
    });
    when('the owner tries to submit it without a file', async () => {
      res = await submit(org, docId, {});
    });
    then('the submission is rejected as a bad request', () => {
      expect(res.status).toBe(400);
    });
  });

  test('a super admin approves a submitted document', ({
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
      await submit(org, docId, { signerName: 'Olivia Owner', method: 'typed' });
    });
    when('the super admin approves the document', async () => {
      res = await approve(org, docId);
    });
    then('the document moves to the approved state', () => {
      expect(res.status).toBe(201);
      expect(res.body.data.document.status).toBe('approved');
    });
  });

  test('approving a document that is not submitted is rejected', ({
    given,
    when,
    then,
  }) => {
    let org: OnboardingOrg;
    let docId: string;
    let res: request.Response;

    given(
      'an onboarding org with a document still in the requested state',
      async () => {
        org = await h.createOnboardingOrg();
        const created = await h.requestDocs(org, {
          customDocuments: [{ title: 'Service Agreement', category: 'agreement', requiresSignature: true, bodyHtml: '<p>sign</p>' }],
        });
        docId = created[0].id;
      },
    );
    when('the super admin tries to approve that requested document', async () => {
      res = await approve(org, docId);
    });
    then('the approval is rejected as a bad request', () => {
      expect(res.status).toBe(400);
    });
  });

  test('a rejected document is reopened for resubmission', ({
    given,
    when,
    then,
    and,
  }) => {
    let org: OnboardingOrg;
    let docId: string;
    let res: request.Response;

    given('an onboarding org with a signed, submitted document', async () => {
      org = await h.createOnboardingOrg();
      const created = await h.requestDocs(org, { customDocuments: [{ title: 'Service Agreement', category: 'agreement', requiresSignature: true, bodyHtml: '<p>sign</p>' }] });
      docId = created[0].id;
      await submit(org, docId, { signerName: 'Olivia Owner', method: 'typed' });
    });
    when('the super admin rejects the document with a reason', async () => {
      res = await reject(org, docId, 'Signature illegible, please redo');
    });
    then('the document moves to the rejected state', () => {
      expect(res.status).toBe(201);
      expect(res.body.data.document.status).toBe('rejected');
    });
    and('the owner can sign and resubmit it back to submitted', async () => {
      const resubmit = await submit(org, docId, {
        signerName: 'Olivia Owner',
        method: 'typed',
      });
      expect(resubmit.status).toBe(201);
      expect(resubmit.body.data.status).toBe('submitted');
    });
  });

  test('a super admin uploads a PDF with placed fields and the owner fills and signs it', ({
    given,
    and,
    when,
    then,
  }) => {
    let org: OnboardingOrg;
    let docId: string;
    let submitRes: request.Response;

    given('a super admin has provisioned an onboarding organization', async () => {
      org = await h.createOnboardingOrg();
    });
    and(
      'the super admin uploads a PDF and requests it with a signature and a name field',
      async () => {
        const up = await h
          .api()
          .post(`/api/v1/admin/organizations/${org.orgId}/upload`)
          .set('Authorization', `Bearer ${org.saToken}`)
          .attach('file', Buffer.from('%PDF-1.4 placed-fields'), {
            filename: 'agreement.pdf',
            contentType: 'application/pdf',
          });
        expect(up.status).toBe(201);
        const sourceFileId = up.body.data.id;
        const created = await h.requestDocs(org, {
          customDocuments: [
            {
              title: 'Prepared Service Agreement',
              category: 'agreement',
              sourceFileId,
              fields: [
                {
                  key: 'name1',
                  type: 'name',
                  page: 0,
                  xPct: 10,
                  yPct: 70,
                  wPct: 40,
                  hPct: 5,
                  required: true,
                  label: 'Full name',
                },
                {
                  key: 'sig1',
                  type: 'signature',
                  page: 0,
                  xPct: 10,
                  yPct: 80,
                  wPct: 30,
                  hPct: 8,
                  required: true,
                  label: 'Signature',
                },
              ],
            },
          ],
        });
        docId = created[0].id;
        // A PDF-with-signature-field doc requires a signature, not an upload.
        expect(created[0].requiresSignature).toBe(true);
        expect(created[0].requiresUpload).toBe(false);
        expect(created[0].sourceFileId).toBe(sourceFileId);
      },
    );
    when(
      'the owner fills the name field and signs the placed signature field',
      async () => {
        const upSig = await h
          .api()
          .post('/api/v1/media/upload')
          .set('Authorization', `Bearer ${org.ownerToken}`)
          .attach('file', Buffer.from('\x89PNG\r\n signature'), {
            filename: 'sig.png',
            contentType: 'image/png',
          });
        expect(upSig.status).toBe(201);
        submitRes = await submit(org, docId, {
          signerName: 'Yara Owner',
          method: 'drawn',
          signatureFileId: upSig.body.data.id,
          fieldValues: [{ key: 'name1', value: 'Yara Owner' }],
        });
      },
    );
    then('the document moves to the submitted state', () => {
      expect(submitRes.status).toBe(201);
      expect(submitRes.body.data.status).toBe('submitted');
    });
    and(
      'the stored signature records the drawn method and the filled field values',
      async () => {
        const view = await h
          .api()
          .get(`/api/v1/admin/organizations/${org.orgId}/onboarding`)
          .set('Authorization', `Bearer ${org.saToken}`);
        const doc = view.body.data.documents.find((d: any) => d.id === docId);
        expect(doc.signature.method).toBe('drawn');
        expect(doc.signature.signatureFileId).toBeTruthy();
        expect(doc.signature.fieldValues.name1).toBe('Yara Owner');
      },
    );
  });

  test('approving the last document activates the organization', ({
    given,
    when,
    then,
    and,
  }) => {
    let org: OnboardingOrg;
    let docId: string;
    let res: request.Response;

    given(
      'an onboarding org whose only document has been submitted',
      async () => {
        org = await h.createOnboardingOrg();
        const created = await h.requestDocs(org, {
          customDocuments: [{ title: 'Service Agreement', category: 'agreement', requiresSignature: true, bodyHtml: '<p>sign</p>' }],
        });
        docId = created[0].id;
        await submit(org, docId, {
          signerName: 'Olivia Owner',
          method: 'typed',
        });
      },
    );
    when('the super admin approves that final document', async () => {
      res = await approve(org, docId);
    });
    then('the onboarding summary reports every document approved', () => {
      expect(res.status).toBe(201);
      expect(res.body.data.summary.allApproved).toBe(true);
    });
    and('the organization becomes active', async () => {
      const orgRow = await h.organizations.findOne({
        where: { id: org.orgId },
      });
      expect(orgRow?.status).toBe('active');
    });
  });
});
