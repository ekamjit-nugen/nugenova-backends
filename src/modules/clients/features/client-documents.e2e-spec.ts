import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import request from 'supertest';

import { bootOrgTestApp, CreatedOrg, OrgTestHarness, randomEmail } from '../../organization/features/support/org-harness';
import { ClientEntity } from '../entities/client.entity';
import { ClientContactEntity } from '../entities/client-contact.entity';
import { ClientDocumentEntity } from '../entities/client-document.entity';
import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';

const feature = loadFeature('./client-documents.feature', { loadRelativePath: true });
const API = '/api/v1';

/** A stand-in DocumentFile id — these tests care about the row, not the bytes. */
const fileId = () => 'f' + Math.random().toString(16).slice(2, 12).padEnd(23, '0');

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let clients: Repository<ClientEntity>;
  let contacts: Repository<ClientContactEntity>;
  let documents: Repository<ClientDocumentEntity>;
  let memberships: Repository<OrgMembershipEntity>;
  const orgIds = new Set<string>();
  const portalUserIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    clients = h.app.get(getRepositoryToken(ClientEntity));
    contacts = h.app.get(getRepositoryToken(ClientContactEntity));
    documents = h.app.get(getRepositoryToken(ClientDocumentEntity));
    memberships = h.app.get(getRepositoryToken(OrgMembershipEntity));
  });

  afterAll(async () => {
    const oids = [...orgIds];
    if (oids.length) {
      await documents.delete({ organizationId: In(oids) }).catch(() => undefined);
      await contacts.delete({ organizationId: In(oids) }).catch(() => undefined);
      await clients.delete({ organizationId: In(oids) }).catch(() => undefined);
    }
    const pids = [...portalUserIds];
    if (pids.length) {
      await memberships.delete({ userId: In(pids) }).catch(() => undefined);
      await h.users.delete({ id: In(pids) }).catch(() => undefined);
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

  /** A client with a portal login. */
  const makeClientWithPortal = async (o: CreatedOrg, companyName = 'Acme Retail') => {
    const client = (await as(o.ownerToken).post('/clients', { companyName }).expect(201)).body.data;
    const email = randomEmail('clientportal');
    const contact = (await as(o.ownerToken).post(`/clients/${client.id}/contacts`, { name: 'Rohan Kapoor', email }).expect(201)).body.data;
    const invited = (await as(o.ownerToken).post(`/clients/${client.id}/contacts/${contact.id}/invite`, {}).expect(201)).body.data;
    portalUserIds.add(invited.userId);
    return { clientId: client.id as string, portalToken: await h.mintToken(email) };
  };

  const share = (o: CreatedOrg, clientId: string, body: object = {}) =>
    as(o.ownerToken).post(`/clients/${clientId}/documents`, {
      fileId: fileId(), fileName: 'statement-of-work.pdf', title: 'Statement of work', ...body,
    });

  const portalDoc = async (token: string, docId: string) => {
    const list = await as(token).get('/clients/portal/documents').expect(200);
    return list.body.data.find((d: { id: string }) => d.id === docId);
  };

  // Shared scenario state.
  let org: CreatedOrg;
  let clientId: string;
  let portalToken: string;
  let docId: string;
  let res: request.Response;

  const givenClientWithPortal = async () => {
    org = await newOrg();
    const made = await makeClientWithPortal(org);
    clientId = made.clientId;
    portalToken = made.portalToken;
  };

  test('a shared document asks for nothing unless the tick is set', ({ given, when, then }) => {
    given('an organization with a client and a portal user', givenClientWithPortal);
    when('the owner shares a document without asking for a signature', async () => {
      res = await share(org, clientId).expect(201);
      docId = res.body.data.id;
    });
    then('the client sees it with nothing to do', async () => {
      expect(res.body.data).toMatchObject({ origin: 'org', signatureRequired: false, status: 'shared' });
      expect(await portalDoc(portalToken, docId)).toMatchObject({ status: 'shared' });
    });
  });

  test('the owner asks the client to sign, and they sign it', ({ given, when, then, and }) => {
    given('an organization with a client and a portal user', givenClientWithPortal);
    when('the owner shares a document and ticks "client must sign"', async () => {
      docId = (await share(org, clientId, { signatureRequired: true }).expect(201)).body.data.id;
    });
    then('the client sees it as needing their signature', async () => {
      expect(await portalDoc(portalToken, docId)).toMatchObject({ signatureRequired: true, status: 'awaiting_client' });
    });
    when('the portal user signs it as "Rohan Kapoor"', async () => {
      res = await as(portalToken).post(`/clients/portal/documents/${docId}/sign`, { signerName: 'Rohan Kapoor' }).expect(201);
    });
    then('the document is signed by them', () => {
      expect(res.body.data.status).toBe('signed');
    });
    and('the signature records who signed and how', () => {
      expect(res.body.data.signature).toMatchObject({ signerName: 'Rohan Kapoor', method: 'typed' });
      expect(res.body.data.signature.signedAt).toBeTruthy();
    });
  });

  test('the tick can be turned on and off after sharing', ({ given, and, when, then }) => {
    given('an organization with a client and a portal user', givenClientWithPortal);
    and('a shared document with no signature asked for', async () => {
      docId = (await share(org, clientId).expect(201)).body.data.id;
    });
    when('the owner ticks "client must sign"', async () => {
      await as(org.ownerToken).patch(`/clients/${clientId}/documents/${docId}`, { signatureRequired: true }).expect(200);
    });
    then('the client sees it as needing their signature', async () => {
      expect(await portalDoc(portalToken, docId)).toMatchObject({ status: 'awaiting_client' });
    });
    when('the owner unticks it', async () => {
      await as(org.ownerToken).patch(`/clients/${clientId}/documents/${docId}`, { signatureRequired: false }).expect(200);
    });
    then('the client sees it with nothing to do', async () => {
      expect(await portalDoc(portalToken, docId)).toMatchObject({ status: 'shared' });
    });
  });

  test('a client sends us a document to sign', ({ given, when, then, and }) => {
    given('an organization with a client and a portal user', givenClientWithPortal);
    when('the portal user sends us a document asking for our signature', async () => {
      res = await as(portalToken)
        .post('/clients/portal/documents', { fileId: fileId(), fileName: 'their-nda.pdf', title: 'Their NDA', requestOurSignature: true })
        .expect(201);
      docId = res.body.data.id;
    });
    then('it appears in our queue of documents to sign', async () => {
      const queue = await as(org.ownerToken).get('/clients/documents/awaiting-signature').expect(200);
      expect(queue.body.data.map((d: { id: string }) => d.id)).toContain(docId);
      expect(queue.body.data[0].clientName).toBe('Acme Retail');
    });
    and('it is marked as having come from the client through the portal', () => {
      expect(res.body.data).toMatchObject({ origin: 'client', channel: 'portal', status: 'awaiting_us' });
      expect(res.body.data.uploadedByName).toBeTruthy();
    });
    when('the owner signs it as "Priya Nair"', async () => {
      res = await as(org.ownerToken).post(`/clients/${clientId}/documents/${docId}/sign`, { signerName: 'Priya Nair' }).expect(201);
    });
    then('the document is signed', () => {
      expect(res.body.data).toMatchObject({ status: 'signed' });
      expect(res.body.data.signature.signerName).toBe('Priya Nair');
    });
    and('our queue is empty', async () => {
      const queue = await as(org.ownerToken).get('/clients/documents/awaiting-signature').expect(200);
      expect(queue.body.data).toHaveLength(0);
    });
  });

  test('a document that arrived by email is recorded for the client', ({ given, when, then, and }) => {
    given('an organization with a client and a portal user', givenClientWithPortal);
    when('the owner records a document that the client emailed', async () => {
      res = await share(org, clientId, {
        fileName: 'emailed-contract.pdf', title: 'Contract they emailed', fromClient: true, fromName: 'Rohan Kapoor', requestOurSignature: true,
      }).expect(201);
      docId = res.body.data.id;
    });
    then('it is marked as having come from the client by email', () => {
      expect(res.body.data).toMatchObject({ origin: 'client', channel: 'email', uploadedByName: 'Rohan Kapoor', status: 'awaiting_us' });
    });
    and('the client can see it in their portal', async () => {
      expect(await portalDoc(portalToken, docId)).toMatchObject({ id: docId, origin: 'client' });
    });
  });

  test('a client cannot sign what was never asked of them', ({ given, and, when, then }) => {
    given('an organization with a client and a portal user', givenClientWithPortal);
    and('a shared document with no signature asked for', async () => {
      docId = (await share(org, clientId).expect(201)).body.data.id;
    });
    when('the portal user tries to sign it', async () => {
      res = await as(portalToken).post(`/clients/portal/documents/${docId}/sign`, { signerName: 'Rohan Kapoor' });
    });
    then('the request is rejected', () => {
      expect(res.status).toBe(400);
    });
  });

  test('signing happens once', ({ given, and, when, then }) => {
    given('an organization with a client and a portal user', givenClientWithPortal);
    and('a document the owner asked the client to sign', async () => {
      docId = (await share(org, clientId, { signatureRequired: true }).expect(201)).body.data.id;
    });
    when('the portal user signs it twice', async () => {
      await as(portalToken).post(`/clients/portal/documents/${docId}/sign`, { signerName: 'Rohan Kapoor' }).expect(201);
      res = await as(portalToken).post(`/clients/portal/documents/${docId}/sign`, { signerName: 'Rohan Kapoor' });
    });
    then('the second attempt is rejected', () => {
      expect(res.status).toBe(400);
    });
  });

  test('a client only ever sees their own documents', ({ given, when, then }) => {
    given('two clients in an organization, each sent a document, and a portal user at the first', async () => {
      await givenClientWithPortal();
      await share(org, clientId, { title: 'Ours' }).expect(201);
      const other = await makeClientWithPortal(org, 'Other Retail');
      await share(org, other.clientId, { title: 'Theirs' }).expect(201);
    });
    when('that portal user lists their documents', async () => {
      res = await as(portalToken).get('/clients/portal/documents').expect(200);
    });
    then("only their own client's document is listed", () => {
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe('Ours');
    });
  });
});
