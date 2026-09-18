import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import request from 'supertest';

import { bootOrgTestApp, CreatedOrg, OrgTestHarness, randomEmail } from '../../organization/features/support/org-harness';
import { VendorEntity } from '../entities/vendor.entity';
import { VendorContactEntity } from '../entities/vendor-contact.entity';
import { VendorDocumentEntity } from '../entities/vendor-document.entity';
import { VendorAgreementEntity } from '../entities/vendor-agreement.entity';

const feature = loadFeature('./vendor-documents.feature', { loadRelativePath: true });
const API = '/api/v1';

/** A stand-in DocumentFile id — these tests care about the row, not the bytes. */
const fileId = () => 'f' + Math.random().toString(16).slice(2, 12).padEnd(23, '0');

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let vendors: Repository<VendorEntity>;
  let contacts: Repository<VendorContactEntity>;
  let documents: Repository<VendorDocumentEntity>;
  let agreements: Repository<VendorAgreementEntity>;
  const orgIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    vendors = h.app.get(getRepositoryToken(VendorEntity));
    contacts = h.app.get(getRepositoryToken(VendorContactEntity));
    documents = h.app.get(getRepositoryToken(VendorDocumentEntity));
    agreements = h.app.get(getRepositoryToken(VendorAgreementEntity));
  });

  afterAll(async () => {
    const oids = [...orgIds];
    if (oids.length) {
      await documents.delete({ organizationId: In(oids) }).catch(() => undefined);
      await agreements.delete({ organizationId: In(oids) }).catch(() => undefined);
      await contacts.delete({ organizationId: In(oids) }).catch(() => undefined);
      await vendors.delete({ organizationId: In(oids) }).catch(() => undefined);
    }
    await h.cleanup();
  });

  const as = (token: string) => ({
    get: (path: string) => h.api().get(`${API}${path}`).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) => h.api().post(`${API}${path}`).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object = {}) => h.api().patch(`${API}${path}`).set('Authorization', `Bearer ${token}`).send(body),
  });

  const newOrg = async (): Promise<CreatedOrg> => {
    const o = await h.createOrg();
    orgIds.add(o.orgId);
    return o;
  };

  /** A vendor with a portal login. */
  const makeVendorWithPortal = async (o: CreatedOrg, companyName = 'Acme Contractors') => {
    const vendor = (await as(o.ownerToken).post('/vendors', { companyName, serviceCategory: 'Staffing' }).expect(201)).body.data;
    const email = randomEmail('vendorportal');
    const contact = (await as(o.ownerToken).post(`/vendors/${vendor.id}/contacts`, { name: 'Riya Verma', email }).expect(201)).body.data;
    // The portal is closed until someone opens it for this vendor.
    await as(o.ownerToken).patch(`/vendors/${vendor.id}/portal`, { enabled: true }).expect(200);
    const invited = (await as(o.ownerToken).post(`/vendors/${vendor.id}/contacts/${contact.id}/invite`, {}).expect(201)).body.data;
    h.trackUser(invited.userId);
    return { vendorId: vendor.id as string, portalToken: await h.mintToken(email) };
  };

  const share = (o: CreatedOrg, vendorId: string, body: object = {}) =>
    as(o.ownerToken).post(`/vendors/${vendorId}/documents`, {
      fileId: fileId(), fileName: 'purchase-order.pdf', title: 'Purchase order', ...body,
    });

  const portalDoc = async (token: string, docId: string) => {
    const list = await as(token).get('/vendor-portal/documents').expect(200);
    return list.body.data.find((d: { id: string }) => d.id === docId);
  };

  // Shared scenario state.
  let org: CreatedOrg;
  let vendorId: string;
  let portalToken: string;
  let docId: string;
  let res: request.Response;

  const givenVendorWithPortal = async () => {
    org = await newOrg();
    const made = await makeVendorWithPortal(org);
    vendorId = made.vendorId;
    portalToken = made.portalToken;
  };

  test('a shared document asks for nothing unless the tick is set', ({ given, when, then }) => {
    given('an organization with a vendor and a portal user', givenVendorWithPortal);
    when('the owner shares a document without asking for a signature', async () => {
      res = await share(org, vendorId).expect(201);
      docId = res.body.data.id;
    });
    then('the vendor sees it with nothing to do', async () => {
      expect(res.body.data).toMatchObject({ signatureRequired: false, status: 'shared' });
      expect(await portalDoc(portalToken, docId)).toMatchObject({ status: 'shared' });
    });
  });

  test('the owner asks the vendor to sign, and they sign it', ({ given, when, then }) => {
    given('an organization with a vendor and a portal user', givenVendorWithPortal);
    when('the owner shares a document and ticks "vendor must sign"', async () => {
      docId = (await share(org, vendorId, { signatureRequired: true }).expect(201)).body.data.id;
    });
    then('the vendor sees it as needing their signature', async () => {
      expect(await portalDoc(portalToken, docId)).toMatchObject({ signatureRequired: true, status: 'awaiting_vendor' });
    });
    when('the portal user signs it as "Riya Verma"', async () => {
      res = await as(portalToken).post(`/vendor-portal/documents/${docId}/sign`, { signerName: 'Riya Verma' }).expect(201);
    });
    then('the document is signed by them', () => {
      expect(res.body.data).toMatchObject({ status: 'signed' });
      expect(res.body.data.signature).toMatchObject({ signerName: 'Riya Verma', method: 'typed' });
    });
  });

  test('the tick can be turned on and off after sharing', ({ given, and, when, then }) => {
    given('an organization with a vendor and a portal user', givenVendorWithPortal);
    and('a shared document with no signature asked for', async () => {
      docId = (await share(org, vendorId).expect(201)).body.data.id;
    });
    when('the owner ticks "vendor must sign"', async () => {
      await as(org.ownerToken).patch(`/vendors/${vendorId}/documents/${docId}`, { signatureRequired: true }).expect(200);
    });
    then('the vendor sees it as needing their signature', async () => {
      expect(await portalDoc(portalToken, docId)).toMatchObject({ status: 'awaiting_vendor' });
    });
    when('the owner unticks it', async () => {
      await as(org.ownerToken).patch(`/vendors/${vendorId}/documents/${docId}`, { signatureRequired: false }).expect(200);
    });
    then('the vendor sees it with nothing to do', async () => {
      expect(await portalDoc(portalToken, docId)).toMatchObject({ status: 'shared' });
    });
  });

  test('signing a document does not decide onboarding', ({ given, and, when, then }) => {
    given('an organization with a vendor and a portal user', givenVendorWithPortal);
    and('a required agreement sent to that vendor', async () => {
      const a = await as(org.ownerToken)
        .post(`/vendors/${vendorId}/agreements`, { title: 'MSA', bodyHtml: '<p>Terms.</p>', requiredForOnboarding: true })
        .expect(201);
      await as(org.ownerToken).post(`/vendors/${vendorId}/agreements/${a.body.data.id}/send`).expect(201);
    });
    when('the owner shares a document the vendor must sign', async () => {
      docId = (await share(org, vendorId, { signatureRequired: true }).expect(201)).body.data.id;
    });
    and('the portal user signs the document', async () => {
      await as(portalToken).post(`/vendor-portal/documents/${docId}/sign`, { signerName: 'Riya Verma' }).expect(201);
    });
    then('the vendor is still not cleared, because the agreement is unsigned', async () => {
      const clearance = await as(org.ownerToken).get(`/vendors/${vendorId}/clearance`).expect(200);
      expect(clearance.body.data).toMatchObject({ cleared: false, outstanding: 1 });
    });
  });

  test('a vendor cannot send us a document', ({ given, when, then }) => {
    given('an organization with a vendor and a portal user', givenVendorWithPortal);
    when('the portal user tries to upload a document', async () => {
      res = await as(portalToken).post('/vendor-portal/documents', { fileId: fileId(), fileName: 'theirs.pdf' });
    });
    then('there is no such route', () => {
      // Deliberate: documents flow one way to a vendor, unlike a client.
      expect(res.status).toBe(404);
    });
  });

  test('a vendor cannot sign what was never asked of them', ({ given, and, when, then }) => {
    given('an organization with a vendor and a portal user', givenVendorWithPortal);
    and('a shared document with no signature asked for', async () => {
      docId = (await share(org, vendorId).expect(201)).body.data.id;
    });
    when('the portal user tries to sign it', async () => {
      res = await as(portalToken).post(`/vendor-portal/documents/${docId}/sign`, { signerName: 'Riya Verma' });
    });
    then('the request is rejected', () => {
      expect(res.status).toBe(400);
    });
  });

  test('a vendor only ever sees their own documents', ({ given, when, then }) => {
    given('two vendors in an organization, each sent a document, and a portal user at the first', async () => {
      await givenVendorWithPortal();
      await share(org, vendorId, { title: 'Ours' }).expect(201);
      const other = await makeVendorWithPortal(org, 'Nova Partners');
      await share(org, other.vendorId, { title: 'Theirs' }).expect(201);
    });
    when('that portal user lists their documents', async () => {
      res = await as(portalToken).get('/vendor-portal/documents').expect(200);
    });
    then("only their own vendor's document is listed", () => {
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe('Ours');
    });
  });
});
