import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import request from 'supertest';

import { bootOrgTestApp, CreatedOrg, OrgTestHarness, randomEmail } from '../../organization/features/support/org-harness';
import { PartnerEntity } from '../entities/partner.entity';

const feature = loadFeature('./partners.feature', { loadRelativePath: true });
const API = '/api/v1';

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let partners: Repository<PartnerEntity>;
  const orgIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    partners = h.app.get(getRepositoryToken(PartnerEntity));
  });

  afterAll(async () => {
    const oids = [...orgIds];
    if (oids.length) await partners.delete({ organizationId: In(oids) }).catch(() => undefined);
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

  const addPartner = (o: CreatedOrg, category: 'client' | 'vendor', companyName: string, body: object = {}) =>
    as(o.ownerToken).post('/partners', { category, companyName, ...body });

  // Shared scenario state.
  let org: CreatedOrg;
  let res: request.Response;

  test('adding a partner asks which side it is on', ({ given, when, then, and }) => {
    given('an organization', async () => {
      org = await newOrg();
    });
    when('the owner adds a client "Acme Retail" and a vendor "Nova Staffing"', async () => {
      await addPartner(org, 'client', 'Acme Retail').expect(201);
      await addPartner(org, 'vendor', 'Nova Staffing').expect(201);
    });
    then('both appear in one partner list, each with its category', async () => {
      res = await as(org.ownerToken).get('/partners').expect(200);
      expect(res.body.data.map((p: { companyName: string; category: string }) => `${p.companyName}:${p.category}`).sort())
        .toEqual(['Acme Retail:client', 'Nova Staffing:vendor']);
    });
    and('the client counts the people we assign to them, the vendor the people they supply', () => {
      // Same field, opposite direction — nobody has to branch to render it.
      res.body.data.forEach((p: { counts: { people: number; contacts: number } }) => {
        expect(p.counts).toEqual({ contacts: 0, people: 0 });
      });
    });
  });

  test('the list can be narrowed to one side', ({ given, when, then }) => {
    given('an organization with a client and a vendor', async () => {
      org = await newOrg();
      await addPartner(org, 'client', 'Acme Retail').expect(201);
      await addPartner(org, 'vendor', 'Nova Staffing').expect(201);
    });
    when('the owner lists only vendors', async () => {
      res = await as(org.ownerToken).get('/partners?category=vendor').expect(200);
    });
    then('only the vendor is listed', () => {
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({ companyName: 'Nova Staffing', category: 'vendor' });
    });
  });

  test('a partner keeps its category for life', ({ given, when, then }) => {
    let id: string;

    given('an organization with a client "Acme Retail"', async () => {
      org = await newOrg();
      id = (await addPartner(org, 'client', 'Acme Retail').expect(201)).body.data.id;
    });
    when('the owner renames it', async () => {
      res = await as(org.ownerToken).patch(`/partners/${id}`, { companyName: 'Acme Retail Group' }).expect(200);
    });
    then('it is still a client', () => {
      expect(res.body.data).toMatchObject({ companyName: 'Acme Retail Group', category: 'client' });
    });
  });

  test('the same name can exist on both sides', ({ given, when, then, but }) => {
    given('an organization with a client "Acme Retail"', async () => {
      org = await newOrg();
      await addPartner(org, 'client', 'Acme Retail').expect(201);
    });
    when('the owner adds a vendor also called "Acme Retail"', async () => {
      res = await addPartner(org, 'vendor', 'Acme Retail');
    });
    then('both exist', async () => {
      expect(res.status).toBe(201);
      const list = await as(org.ownerToken).get('/partners').expect(200);
      expect(list.body.data).toHaveLength(2);
    });
    but('adding a second client called "Acme Retail" is rejected', async () => {
      const denied = await addPartner(org, 'client', 'Acme Retail');
      expect(denied.status).toBe(409);
    });
  });

  test("one field covers a client's industry and a vendor's service", ({ given, when, then }) => {
    given('an organization', async () => {
      org = await newOrg();
    });
    when('the owner adds a client in "Retail" and a vendor in "Staffing"', async () => {
      await addPartner(org, 'client', 'Acme Retail', { sector: 'Retail' }).expect(201);
      await addPartner(org, 'vendor', 'Nova Staffing', { sector: 'Staffing' }).expect(201);
    });
    then('each reports its own sector', async () => {
      res = await as(org.ownerToken).get('/partners').expect(200);
      const bySector = Object.fromEntries(res.body.data.map((p: { category: string; sector: string }) => [p.category, p.sector]));
      expect(bySector).toEqual({ client: 'Retail', vendor: 'Staffing' });
    });
  });

  test('a role granted only one side sees only that side', ({ given, and, when, then }) => {
    let member: string;

    given('an organization with a client and a vendor', async () => {
      org = await newOrg();
      await addPartner(org, 'client', 'Acme Retail').expect(201);
      await addPartner(org, 'vendor', 'Nova Staffing').expect(201);
    });
    and('a member whose role grants "clients:view" only', async () => {
      const role = await as(org.ownerToken)
        .post('/org/roles', { name: `client-viewer-${Date.now()}`, displayName: 'Client viewer', permissions: [{ resource: 'clients', actions: ['view'] }] })
        .expect(201);
      const email = randomEmail('clientviewer');
      const added = await as(org.ownerToken)
        .post('/org/members', { email, roleId: role.body.data.id, firstName: 'Cara', lastName: 'Viewer' })
        .expect(201);
      h.trackUser(added.body.data.userId);
      member = await h.mintToken(email);
    });
    when('that member lists the partners', async () => {
      res = await as(member).get('/partners').expect(200);
    });
    then('only the client is listed', () => {
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].category).toBe('client');
    });
    and('adding a vendor is rejected as forbidden', async () => {
      const denied = await as(member).post('/partners', { category: 'vendor', companyName: 'Sneaky Supplies' });
      expect(denied.status).toBe(403);
    });
  });

  test('partners never cross organizations', ({ given, when, then }) => {
    given('two organizations each with a partner', async () => {
      org = await newOrg();
      const second = await newOrg();
      await addPartner(org, 'client', 'Ours').expect(201);
      await addPartner(second, 'vendor', 'Theirs').expect(201);
    });
    when('the first owner lists the partners', async () => {
      res = await as(org.ownerToken).get('/partners').expect(200);
    });
    then('only their own is listed', () => {
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].companyName).toBe('Ours');
    });
  });
});
