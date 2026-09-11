import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import request from 'supertest';

import {
  bootOrgTestApp,
  CreatedOrg,
  OrgTestHarness,
} from '../../organization/features/support/org-harness';
import { ClientEntity } from '../entities/client.entity';
import { ClientContactEntity } from '../entities/client-contact.entity';
import { ClientAssignmentEntity } from '../entities/client-assignment.entity';
import { BoardClientShareEntity } from '../entities/board-client-share.entity';
import { ClientAgreementEntity } from '../entities/client-agreement.entity';
import { DiscussionBoardEntity } from '../../discussion-boards/entities/discussion-board.entity';
import { BoardCommentEntity } from '../../discussion-boards/entities/board-comment.entity';
import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';

const feature = loadFeature('./clients.feature', { loadRelativePath: true });
const API = '/api/v1';

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let clients: Repository<ClientEntity>;
  let contacts: Repository<ClientContactEntity>;
  let assignments: Repository<ClientAssignmentEntity>;
  let shares: Repository<BoardClientShareEntity>;
  let agreementsRepo: Repository<ClientAgreementEntity>;
  let boards: Repository<DiscussionBoardEntity>;
  let comments: Repository<BoardCommentEntity>;
  let memberships: Repository<OrgMembershipEntity>;
  const orgIds = new Set<string>();
  const boardIds = new Set<string>();
  const portalUserIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    clients = h.app.get(getRepositoryToken(ClientEntity));
    contacts = h.app.get(getRepositoryToken(ClientContactEntity));
    assignments = h.app.get(getRepositoryToken(ClientAssignmentEntity));
    shares = h.app.get(getRepositoryToken(BoardClientShareEntity));
    agreementsRepo = h.app.get(getRepositoryToken(ClientAgreementEntity));
    boards = h.app.get(getRepositoryToken(DiscussionBoardEntity));
    comments = h.app.get(getRepositoryToken(BoardCommentEntity));
    memberships = h.app.get(getRepositoryToken(OrgMembershipEntity));
  });

  afterAll(async () => {
    const oids = [...orgIds];
    const bids = [...boardIds];
    if (bids.length) {
      await comments.delete({ boardId: In(bids) }).catch(() => undefined);
      await shares.delete({ boardId: In(bids) }).catch(() => undefined);
      await boards.delete({ id: In(bids) }).catch(() => undefined);
    }
    if (oids.length) {
      await agreementsRepo.delete({ organizationId: In(oids) }).catch(() => undefined);
      await shares.delete({ organizationId: In(oids) }).catch(() => undefined);
      await assignments.delete({ organizationId: In(oids) }).catch(() => undefined);
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

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const newOrg = async (): Promise<CreatedOrg> => {
    const o = await h.createOrg();
    orgIds.add(o.orgId);
    return o;
  };

  const createClient = (o: CreatedOrg, companyName: string, token = o.ownerToken) =>
    h.api().post(`${API}/clients`).set(auth(token)).send({ companyName });

  const makeBoard = async (o: CreatedOrg, title: string): Promise<string> => {
    const b = await boards.save(
      boards.create({
        organizationId: o.orgId,
        title,
        description: null,
        createdBy: o.ownerId,
        createdByName: 'Owner One',
        participants: [],
        isArchived: false,
        isDeleted: false,
      }),
    );
    boardIds.add(b.id);
    return b.id;
  };

  /** Create a client + an invited portal user; returns ids + the portal token. */
  const clientWithPortalUser = async (o: CreatedOrg, companyName = 'Acme Corp') => {
    const c = (await createClient(o, companyName).expect(201)).body.data;
    const contact = (
      await h
        .api()
        .post(`${API}/clients/${c.id}/contacts`)
        .set(auth(o.ownerToken))
        .send({ name: 'Jane Doe', email: `jane+${c.id}@portal.test` })
        .expect(201)
    ).body.data;
    const invited = (
      await h
        .api()
        .post(`${API}/clients/${c.id}/contacts/${contact.id}/invite`)
        .set(auth(o.ownerToken))
        .send({})
        .expect(201)
    ).body.data;
    portalUserIds.add(invited.userId);
    const portalToken = await h.mintToken(invited.email);
    return { clientId: c.id, contactId: contact.id, portalUserId: invited.userId, portalEmail: invited.email, portalToken };
  };

  // ── management ───────────────────────────────────────────────────────────────

  test('an admin creates a client', ({ given, when, then, and }) => {
    let o: CreatedOrg;
    let res: request.Response;

    given('an organization', async () => { o = await newOrg(); });
    when('the owner creates a client "Acme Corp"', async () => {
      res = await createClient(o, 'Acme Corp').expect(201);
    });
    then('the client is stored with status "active"', () => {
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.status).toBe('active');
    });
    and("the client appears in the org's client list", async () => {
      const list = await h.api().get(`${API}/clients`).set(auth(o.ownerToken)).expect(200);
      expect((list.body.data as any[]).map((c) => c.companyName)).toContain('Acme Corp');
    });
  });

  test('duplicate company names are rejected', ({ given, when, then }) => {
    let o: CreatedOrg;
    let res: request.Response;

    given('an organization with a client "Acme Corp"', async () => {
      o = await newOrg();
      await createClient(o, 'Acme Corp').expect(201);
    });
    when('the owner creates a client "Acme Corp" again', async () => {
      res = await createClient(o, 'Acme Corp');
    });
    then('the create is rejected as a conflict', () => {
      expect(res.status).toBe(409);
    });
  });

  test('a non-admin cannot create a client', ({ given, when, then }) => {
    let o: CreatedOrg;
    let emp: { email: string; userId: string; token: string };
    let res: request.Response;

    given('an organization with an employee member', async () => {
      o = await newOrg();
      emp = await h.createEmployeeMember(o);
    });
    when('the employee tries to create a client "Sneaky Inc"', async () => {
      res = await createClient(o, 'Sneaky Inc', emp.token);
    });
    then('the create is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  test('an admin adds a contact and invites them to the portal', ({ given, when, then, and }) => {
    let o: CreatedOrg;
    let clientId: string;
    let contactId: string;
    let invited: any;

    given('an organization with a client "Acme Corp"', async () => {
      o = await newOrg();
      clientId = (await createClient(o, 'Acme Corp').expect(201)).body.data.id;
    });
    when('the owner adds a contact "Jane Doe" with an email', async () => {
      const res = await h
        .api()
        .post(`${API}/clients/${clientId}/contacts`)
        .set(auth(o.ownerToken))
        .send({ name: 'Jane Doe', email: `jane+${clientId}@portal.test` })
        .expect(201);
      contactId = res.body.data.id;
    });
    and('the owner invites that contact to the portal', async () => {
      const res = await h
        .api()
        .post(`${API}/clients/${clientId}/contacts/${contactId}/invite`)
        .set(auth(o.ownerToken))
        .send({})
        .expect(201);
      invited = res.body.data;
      portalUserIds.add(invited.userId);
    });
    then('a client-role portal login exists for that email', async () => {
      const m = await memberships.findOne({ where: { userId: invited.userId, organizationId: o.orgId } });
      expect(m?.role).toBe('client');
      expect(m?.clientId).toBe(clientId);
    });
    and('that portal user can sign in and reach the portal overview', async () => {
      const token = await h.mintToken(invited.email);
      const res = await h.api().get(`${API}/clients/portal/overview`).set(auth(token)).expect(200);
      expect(res.body.data.client.companyName).toBe('Acme Corp');
    });
  });

  test('an assigned employee sees the client in "my clients"', ({ given, when, then }) => {
    let o: CreatedOrg;
    let clientId: string;
    let emp: { email: string; userId: string; token: string };

    given('an organization with a client "Acme Corp" and an employee member', async () => {
      o = await newOrg();
      clientId = (await createClient(o, 'Acme Corp').expect(201)).body.data.id;
      emp = await h.createEmployeeMember(o);
    });
    when('the owner assigns the employee to the client as "Account Manager"', async () => {
      await h
        .api()
        .post(`${API}/clients/${clientId}/assignments`)
        .set(auth(o.ownerToken))
        .send({ userId: emp.userId, assignmentRole: 'Account Manager' })
        .expect(201);
    });
    then('the employee\'s "my clients" list includes "Acme Corp"', async () => {
      const res = await h.api().get(`${API}/clients/mine`).set(auth(emp.token)).expect(200);
      const rows = res.body.data as any[];
      expect(rows.map((c) => c.companyName)).toContain('Acme Corp');
      expect(rows.find((c) => c.companyName === 'Acme Corp').assignmentRole).toBe('Account Manager');
    });
  });

  // ── portal ─────────────────────────────────────────────────────────────────

  test('a portal user sees a board shared with their client', ({ given, and, when, then }) => {
    let o: CreatedOrg;
    let pu: Awaited<ReturnType<typeof clientWithPortalUser>>;

    given('an organization with a client "Acme Corp" and a portal user', async () => {
      o = await newOrg();
      pu = await clientWithPortalUser(o);
    });
    and('a board "Delivery Board" shared with the client with "view" permission', async () => {
      const boardId = await makeBoard(o, 'Delivery Board');
      await h.api().post(`${API}/clients/${pu.clientId}/boards`).set(auth(o.ownerToken)).send({ boardId, permission: 'view' }).expect(201);
    });
    when('the portal user loads their overview', async () => {
      (pu as any).overview = (await h.api().get(`${API}/clients/portal/overview`).set(auth(pu.portalToken)).expect(200)).body.data;
    });
    then('the overview lists the board "Delivery Board"', () => {
      expect(((pu as any).overview.boards as any[]).map((b) => b.title)).toContain('Delivery Board');
    });
  });

  test('a portal user can read a board shared with their client', ({ given, and, when, then }) => {
    let o: CreatedOrg;
    let pu: Awaited<ReturnType<typeof clientWithPortalUser>>;
    let boardId: string;
    let res: request.Response;

    given('an organization with a client "Acme Corp" and a portal user', async () => {
      o = await newOrg();
      pu = await clientWithPortalUser(o);
    });
    and('a board "Delivery Board" shared with the client with "view" permission', async () => {
      boardId = await makeBoard(o, 'Delivery Board');
      await h.api().post(`${API}/clients/${pu.clientId}/boards`).set(auth(o.ownerToken)).send({ boardId, permission: 'view' }).expect(201);
    });
    when('the portal user opens the shared board', async () => {
      res = await h.api().get(`${API}/clients/portal/boards/${boardId}`).set(auth(pu.portalToken)).expect(200);
    });
    then('the board reads back with its title "Delivery Board"', () => {
      expect(res.body.data.board.title).toBe('Delivery Board');
    });
  });

  test('a portal user with comment permission can comment', ({ given, and, when, then }) => {
    let o: CreatedOrg;
    let pu: Awaited<ReturnType<typeof clientWithPortalUser>>;
    let boardId: string;

    given('an organization with a client "Acme Corp" and a portal user', async () => {
      o = await newOrg();
      pu = await clientWithPortalUser(o);
    });
    and('a board "Delivery Board" shared with the client with "comment" permission', async () => {
      boardId = await makeBoard(o, 'Delivery Board');
      await h.api().post(`${API}/clients/${pu.clientId}/boards`).set(auth(o.ownerToken)).send({ boardId, permission: 'comment' }).expect(201);
    });
    when('the portal user posts a comment "Looks great" on the board', async () => {
      await h.api().post(`${API}/clients/portal/boards/${boardId}/comments`).set(auth(pu.portalToken)).send({ text: 'Looks great' }).expect(201);
    });
    then('the comment is stored on the board', async () => {
      const found = await comments.findOne({ where: { boardId, authorId: pu.portalUserId } });
      expect(found?.text).toBe('Looks great');
    });
  });

  test('a view-only portal user cannot comment', ({ given, and, when, then }) => {
    let o: CreatedOrg;
    let pu: Awaited<ReturnType<typeof clientWithPortalUser>>;
    let boardId: string;
    let res: request.Response;

    given('an organization with a client "Acme Corp" and a portal user', async () => {
      o = await newOrg();
      pu = await clientWithPortalUser(o);
    });
    and('a board "Delivery Board" shared with the client with "view" permission', async () => {
      boardId = await makeBoard(o, 'Delivery Board');
      await h.api().post(`${API}/clients/${pu.clientId}/boards`).set(auth(o.ownerToken)).send({ boardId, permission: 'view' }).expect(201);
    });
    when('the portal user posts a comment "Can I edit this" on the board', async () => {
      res = await h.api().post(`${API}/clients/portal/boards/${boardId}/comments`).set(auth(pu.portalToken)).send({ text: 'Can I edit this' });
    });
    then('the comment is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  test('a portal user cannot read a board not shared with their client', ({ given, and, when, then }) => {
    let o: CreatedOrg;
    let pu: Awaited<ReturnType<typeof clientWithPortalUser>>;
    let boardId: string;
    let res: request.Response;

    given('an organization with a client "Acme Corp" and a portal user', async () => {
      o = await newOrg();
      pu = await clientWithPortalUser(o);
    });
    and('a board "Private Board" that is not shared with the client', async () => {
      boardId = await makeBoard(o, 'Private Board');
    });
    when('the portal user tries to open the unshared board', async () => {
      res = await h.api().get(`${API}/clients/portal/boards/${boardId}`).set(auth(pu.portalToken));
    });
    then('the read is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  test('archiving a client suspends its portal logins', ({ given, when, then, and }) => {
    let o: CreatedOrg;
    let pu: Awaited<ReturnType<typeof clientWithPortalUser>>;

    given('an organization with a client "Acme Corp" and a portal user', async () => {
      o = await newOrg();
      pu = await clientWithPortalUser(o);
    });
    when('the owner archives the client', async () => {
      await h.api().post(`${API}/clients/${pu.clientId}/archive`).set(auth(o.ownerToken)).expect(201);
    });
    then('the portal login is deactivated', async () => {
      const m = await memberships.findOne({ where: { userId: pu.portalUserId, clientId: pu.clientId } });
      expect(m?.status).toBe('deactivated');
    });
    and('the portal user is refused the portal overview', async () => {
      await h.api().get(`${API}/clients/portal/overview`).set(auth(pu.portalToken)).expect(403);
    });
  });

  test('deleting a client cascades its shares and assignments', ({ given, when, then, and }) => {
    let o: CreatedOrg;
    let clientId: string;
    let boardId: string;
    let emp: { email: string; userId: string; token: string };

    given('an organization with a client "Acme Corp", an assigned employee, and a shared board', async () => {
      o = await newOrg();
      clientId = (await createClient(o, 'Acme Corp').expect(201)).body.data.id;
      emp = await h.createEmployeeMember(o);
      await h.api().post(`${API}/clients/${clientId}/assignments`).set(auth(o.ownerToken)).send({ userId: emp.userId }).expect(201);
      boardId = await makeBoard(o, 'Delivery Board');
      await h.api().post(`${API}/clients/${clientId}/boards`).set(auth(o.ownerToken)).send({ boardId, permission: 'view' }).expect(201);
    });
    when('the owner deletes the client', async () => {
      await h.api().delete(`${API}/clients/${clientId}`).set(auth(o.ownerToken)).expect(200);
    });
    then('the client no longer appears in the client list', async () => {
      const list = await h.api().get(`${API}/clients?status=all`).set(auth(o.ownerToken)).expect(200);
      expect((list.body.data as any[]).map((c) => c.id)).not.toContain(clientId);
    });
    and('the board share and the assignment are gone', async () => {
      expect(await shares.count({ where: { clientId } })).toBe(0);
      expect(await assignments.count({ where: { clientId } })).toBe(0);
    });
  });

  test('one organization cannot read another organization\'s client', ({ given, when, then }) => {
    let o1: CreatedOrg;
    let o2: CreatedOrg;
    let otherClientId: string;
    let res: request.Response;

    given('two separate organizations each with a client', async () => {
      o1 = await newOrg();
      o2 = await newOrg();
      await createClient(o1, 'First Co').expect(201);
      otherClientId = (await createClient(o2, 'Second Co').expect(201)).body.data.id;
    });
    when("the first owner tries to read the second org's client", async () => {
      res = await h.api().get(`${API}/clients/${otherClientId}`).set(auth(o1.ownerToken));
    });
    then('the read is rejected as not found', () => {
      expect(res.status).toBe(404);
    });
  });

  // ── agreements ───────────────────────────────────────────────────────────────

  test('an admin sends an agreement and the client signs it', ({ given, and, when, then }) => {
    let o: CreatedOrg;
    let pu: Awaited<ReturnType<typeof clientWithPortalUser>>;
    let agreementId: string;
    let signed: request.Response;

    given('an organization with a client "Acme Corp" and a portal user', async () => {
      o = await newOrg();
      pu = await clientWithPortalUser(o);
    });
    and('the owner creates and sends an agreement "Mutual NDA" to the client', async () => {
      const a = (await h.api().post(`${API}/clients/${pu.clientId}/agreements`).set(auth(o.ownerToken)).send({ title: 'Mutual NDA', category: 'nda', bodyHtml: '<p>terms</p>' }).expect(201)).body.data;
      agreementId = a.id;
      await h.api().post(`${API}/clients/${pu.clientId}/agreements/${agreementId}/send`).set(auth(o.ownerToken)).expect(201);
    });
    when('the portal user signs the agreement', async () => {
      signed = await h.api().post(`${API}/clients/portal/agreements/${agreementId}/sign`).set(auth(pu.portalToken)).send({ signerName: 'Jane Doe', method: 'typed' }).expect(201);
    });
    then("the agreement is recorded as signed with the signer's name", () => {
      expect(signed.body.data.status).toBe('signed');
      expect(signed.body.data.signature.signerName).toBe('Jane Doe');
    });
    and('the owner sees the agreement as signed', async () => {
      const list = await h.api().get(`${API}/clients/${pu.clientId}/agreements`).set(auth(o.ownerToken)).expect(200);
      expect((list.body.data as any[]).find((a) => a.id === agreementId).status).toBe('signed');
    });
  });

  test('a portal user cannot sign an agreement that was not sent', ({ given, and, when, then }) => {
    let o: CreatedOrg;
    let pu: Awaited<ReturnType<typeof clientWithPortalUser>>;
    let agreementId: string;
    let res: request.Response;

    given('an organization with a client "Acme Corp" and a portal user', async () => {
      o = await newOrg();
      pu = await clientWithPortalUser(o);
    });
    and('the owner creates a draft agreement "Draft NDA" without sending it', async () => {
      const a = (await h.api().post(`${API}/clients/${pu.clientId}/agreements`).set(auth(o.ownerToken)).send({ title: 'Draft NDA', bodyHtml: '<p>terms</p>' }).expect(201)).body.data;
      agreementId = a.id;
    });
    when('the portal user tries to sign the draft agreement', async () => {
      res = await h.api().post(`${API}/clients/portal/agreements/${agreementId}/sign`).set(auth(pu.portalToken)).send({ signerName: 'Jane Doe' });
    });
    then('the sign is rejected as not found', () => {
      expect(res.status).toBe(404);
    });
  });

  test('a signed agreement cannot be signed again', ({ given, and, when, then }) => {
    let o: CreatedOrg;
    let pu: Awaited<ReturnType<typeof clientWithPortalUser>>;
    let agreementId: string;
    let res: request.Response;

    given('an organization with a client "Acme Corp" and a portal user', async () => {
      o = await newOrg();
      pu = await clientWithPortalUser(o);
    });
    and('the owner creates and sends an agreement "Mutual NDA" to the client', async () => {
      const a = (await h.api().post(`${API}/clients/${pu.clientId}/agreements`).set(auth(o.ownerToken)).send({ title: 'Mutual NDA', category: 'nda', bodyHtml: '<p>terms</p>' }).expect(201)).body.data;
      agreementId = a.id;
      await h.api().post(`${API}/clients/${pu.clientId}/agreements/${agreementId}/send`).set(auth(o.ownerToken)).expect(201);
    });
    and('the portal user has signed it', async () => {
      await h.api().post(`${API}/clients/portal/agreements/${agreementId}/sign`).set(auth(pu.portalToken)).send({ signerName: 'Jane Doe', method: 'typed' }).expect(201);
    });
    when('the portal user tries to sign it again', async () => {
      res = await h.api().post(`${API}/clients/portal/agreements/${agreementId}/sign`).set(auth(pu.portalToken)).send({ signerName: 'Jane Doe', method: 'typed' });
    });
    then('the sign is rejected as a bad request', () => {
      expect(res.status).toBe(400);
    });
  });
});
