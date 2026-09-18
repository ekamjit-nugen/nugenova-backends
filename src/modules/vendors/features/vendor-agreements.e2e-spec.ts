import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import request from 'supertest';

import { bootOrgTestApp, CreatedOrg, OrgTestHarness, randomEmail } from '../../organization/features/support/org-harness';
import { VendorEntity } from '../entities/vendor.entity';
import { VendorAgreementEntity } from '../entities/vendor-agreement.entity';
import { VendorAgreementTemplateEntity } from '../entities/vendor-agreement-template.entity';

const feature = loadFeature('./vendor-agreements.feature', { loadRelativePath: true });
const API = '/api/v1';

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let vendors: Repository<VendorEntity>;
  let agreements: Repository<VendorAgreementEntity>;
  let templates: Repository<VendorAgreementTemplateEntity>;
  const orgIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    vendors = h.app.get(getRepositoryToken(VendorEntity));
    agreements = h.app.get(getRepositoryToken(VendorAgreementEntity));
    templates = h.app.get(getRepositoryToken(VendorAgreementTemplateEntity));
  });

  afterAll(async () => {
    const oids = [...orgIds];
    if (oids.length) {
      await agreements.delete({ organizationId: In(oids) }).catch(() => undefined);
      await templates.delete({ organizationId: In(oids) }).catch(() => undefined);
      await vendors.delete({ organizationId: In(oids) }).catch(() => undefined);
    }
    await h.cleanup();
  });

  const as = (token: string) => ({
    get: (path: string) => h.api().get(`${API}${path}`).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) => h.api().post(`${API}${path}`).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object = {}) => h.api().patch(`${API}${path}`).set('Authorization', `Bearer ${token}`).send(body),
    del: (path: string) => h.api().delete(`${API}${path}`).set('Authorization', `Bearer ${token}`),
  });

  const newOrg = async (): Promise<CreatedOrg> => {
    const o = await h.createOrg();
    orgIds.add(o.orgId);
    return o;
  };

  const addVendor = async (o: CreatedOrg, companyName = 'Acme Contractors', serviceCategory = 'Staffing'): Promise<string> =>
    (await as(o.ownerToken).post('/vendors', { companyName, serviceCategory }).expect(201)).body.data.id;

  const addTemplate = async (o: CreatedOrg, body: object = {}): Promise<string> =>
    (await as(o.ownerToken)
      .post('/vendors/agreement-templates', {
        name: 'Master Services Agreement',
        bodyHtml: '<p>Standard MSA terms.</p>',
        category: 'msa',
        required: true,
        ...body,
      })
      .expect(201)).body.data.id;

  // Shared scenario state.
  let org: CreatedOrg;
  let vendorId: string;
  let templateId: string;
  let agreementId: string;
  let res: request.Response;

  test('an admin authors a template and issues it to a vendor', ({ given, and, when, then }) => {
    given('an organization with a vendor "Acme Contractors"', async () => {
      org = await newOrg();
      vendorId = await addVendor(org);
    });
    and('a required agreement template "Master Services Agreement"', async () => {
      templateId = await addTemplate(org);
    });
    when('the owner issues the required agreements to that vendor', async () => {
      res = await as(org.ownerToken).post(`/vendors/${vendorId}/agreements/issue-required`).expect(201);
    });
    then('the vendor has an agreement "Master Services Agreement" in draft', async () => {
      expect(res.body.data.created).toBe(1);
      const list = await as(org.ownerToken).get(`/vendors/${vendorId}/agreements`).expect(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).toMatchObject({ title: 'Master Services Agreement', status: 'draft', templateId, requiredForOnboarding: true });
    });
    and('the vendor is not cleared, with 1 outstanding', async () => {
      const clearance = await as(org.ownerToken).get(`/vendors/${vendorId}/clearance`).expect(200);
      expect(clearance.body.data).toMatchObject({ cleared: false, outstanding: 1 });
    });
  });

  test('the agreement keeps its own copy of the template text', ({ given, and, when, then }) => {
    given('an organization with a vendor "Acme Contractors"', async () => {
      org = await newOrg();
      vendorId = await addVendor(org);
    });
    and('a required agreement template "Master Services Agreement"', async () => {
      templateId = await addTemplate(org);
    });
    and('that template has been issued to the vendor', async () => {
      await as(org.ownerToken).post(`/vendors/${vendorId}/agreements/issue-required`).expect(201);
    });
    when('the owner rewrites the template text', async () => {
      await as(org.ownerToken).patch(`/vendors/agreement-templates/${templateId}`, { bodyHtml: '<p>Completely new terms.</p>' }).expect(200);
    });
    then("the vendor's agreement still shows the original text", async () => {
      const list = await as(org.ownerToken).get(`/vendors/${vendorId}/agreements`).expect(200);
      expect(list.body.data[0].bodyHtml).toBe('<p>Standard MSA terms.</p>');
    });
  });

  test('recording the signature clears the vendor', ({ given, and, when, then }) => {
    given('an organization with a vendor "Acme Contractors"', async () => {
      org = await newOrg();
      vendorId = await addVendor(org);
    });
    and('a required agreement template "Master Services Agreement"', async () => {
      templateId = await addTemplate(org);
    });
    and('that template has been issued to the vendor', async () => {
      const issued = await as(org.ownerToken).post(`/vendors/${vendorId}/agreements/issue-required`).expect(201);
      agreementId = issued.body.data.agreements[0].id;
      await as(org.ownerToken).post(`/vendors/${vendorId}/agreements/${agreementId}/send`).expect(201);
    });
    when('the owner records that "Riya Verma" signed it', async () => {
      res = await as(org.ownerToken)
        .post(`/vendors/${vendorId}/agreements/${agreementId}/sign`, { signerName: 'Riya Verma', recordedNote: 'Signed copy received by email' })
        .expect(201);
    });
    then('the vendor is cleared', async () => {
      const clearance = await as(org.ownerToken).get(`/vendors/${vendorId}/clearance`).expect(200);
      expect(clearance.body.data).toMatchObject({ cleared: true, outstanding: 0 });
    });
    and('the vendor\'s onboarding status is "active"', async () => {
      const v = await as(org.ownerToken).get(`/vendors/${vendorId}`).expect(200);
      expect(v.body.data.onboardingStatus).toBe('active');
      expect(v.body.data.onboardedAt).toBeTruthy();
    });
    and('the signature records who recorded it', () => {
      expect(res.body.data.signature).toMatchObject({
        signerName: 'Riya Verma', method: 'offline', recordedNote: 'Signed copy received by email',
      });
      expect(res.body.data.signature.signedByUserId).toBe(org.ownerId);
    });
  });

  test('a signed agreement is a record, not a draft', ({ given, and, when, then }) => {
    given('an organization with a vendor "Acme Contractors"', async () => {
      org = await newOrg();
      vendorId = await addVendor(org);
    });
    and('a signed agreement at that vendor', async () => {
      const created = await as(org.ownerToken)
        .post(`/vendors/${vendorId}/agreements`, { title: 'NDA', bodyHtml: '<p>Confidentiality.</p>', category: 'nda' })
        .expect(201);
      agreementId = created.body.data.id;
      await as(org.ownerToken).post(`/vendors/${vendorId}/agreements/${agreementId}/sign`, { signerName: 'Riya Verma' }).expect(201);
    });
    when('the owner tries to edit it', async () => {
      res = await as(org.ownerToken).patch(`/vendors/${vendorId}/agreements/${agreementId}`, { title: 'NDA (revised)' });
    });
    then('the request is rejected', () => {
      expect(res.status).toBe(400);
    });
    and('deleting it is rejected too', async () => {
      const del = await as(org.ownerToken).del(`/vendors/${vendorId}/agreements/${agreementId}`);
      expect(del.status).toBe(400);
    });
  });

  test('a template aimed at another service category is not required', ({ given, and, when, then }) => {
    given('an organization with a vendor "Acme Contractors" in "Staffing"', async () => {
      org = await newOrg();
      vendorId = await addVendor(org, 'Acme Contractors', 'Staffing');
    });
    and('a required agreement template that applies only to "Facilities"', async () => {
      await addTemplate(org, { name: 'Facilities addendum', appliesToCategories: ['Facilities'] });
    });
    when("the owner asks for the vendor's clearance", async () => {
      res = await as(org.ownerToken).get(`/vendors/${vendorId}/clearance`).expect(200);
    });
    then('the vendor is cleared', () => {
      expect(res.body.data).toMatchObject({ cleared: true, outstanding: 0 });
    });
  });

  test('an expired agreement stops clearing the vendor', ({ given, and, when, then }) => {
    given('an organization with a vendor "Acme Contractors"', async () => {
      org = await newOrg();
      vendorId = await addVendor(org);
    });
    and('a required agreement that was signed but has expired', async () => {
      const created = await as(org.ownerToken)
        .post(`/vendors/${vendorId}/agreements`, {
          title: 'Insurance certificate',
          bodyHtml: '<p>Cover for the year.</p>',
          requiredForOnboarding: true,
          expiresAt: '2026-01-31T00:00:00.000Z',
        })
        .expect(201);
      agreementId = created.body.data.id;
      await as(org.ownerToken)
        .post(`/vendors/${vendorId}/agreements/${agreementId}/sign`, { signerName: 'Riya Verma', signedAt: '2026-01-01T00:00:00.000Z' })
        .expect(201);
    });
    when("the owner asks for the vendor's clearance", async () => {
      res = await as(org.ownerToken).get(`/vendors/${vendorId}/clearance`).expect(200);
    });
    then('the vendor is not cleared', () => {
      expect(res.body.data.cleared).toBe(false);
    });
    and('the agreement is listed as "expired"', () => {
      expect(res.body.data.items.find((i: { agreementId: string }) => i.agreementId === agreementId).status).toBe('expired');
    });
  });

  test('a member with only vendors:view cannot author templates', ({ given, when, then, but }) => {
    let viewer: string;

    given('an organization and a member whose role grants "vendors:view"', async () => {
      org = await newOrg();
      await addTemplate(org);
      const role = await as(org.ownerToken)
        .post('/org/roles', { name: `vendor-viewer-${Date.now()}`, displayName: 'Vendor viewer', permissions: [{ resource: 'vendors', actions: ['view'] }] })
        .expect(201);
      const email = randomEmail('vendorviewer');
      const added = await as(org.ownerToken)
        .post('/org/members', { email, roleId: role.body.data.id, firstName: 'Vera', lastName: 'Viewer' })
        .expect(201);
      h.trackUser(added.body.data.userId);
      viewer = await h.mintToken(email);
    });
    when('that member lists the agreement templates', async () => {
      res = await as(viewer).get('/vendors/agreement-templates').expect(200);
    });
    then('the list is returned', () => {
      expect(res.body.data).toHaveLength(1);
    });
    but('creating a template is rejected as forbidden', async () => {
      const denied = await as(viewer).post('/vendors/agreement-templates', { name: 'Sneaky', bodyHtml: '<p>x</p>' });
      expect(denied.status).toBe(403);
    });
  });

  test('templates never cross organizations', ({ given, when, then }) => {
    given('two organizations each with an agreement template', async () => {
      org = await newOrg();
      const second = await newOrg();
      await addTemplate(org, { name: 'Ours' });
      await addTemplate(second, { name: 'Theirs' });
    });
    when('the first owner lists the agreement templates', async () => {
      res = await as(org.ownerToken).get('/vendors/agreement-templates').expect(200);
    });
    then("only the first organization's template is listed", () => {
      expect(res.body.data.map((t: { name: string }) => t.name)).toEqual(['Ours']);
    });
  });
});
