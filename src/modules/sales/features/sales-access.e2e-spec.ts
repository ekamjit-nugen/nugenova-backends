import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import request from 'supertest';

import {
  bootOrgTestApp,
  OrgTestHarness,
  CreatedOrg,
  randomEmail,
} from '../../organization/features/support/org-harness';
import { LeadEntity } from '../entities/lead.entity';
import { PipelineStageEntity } from '../entities/pipeline-stage.entity';

const feature = loadFeature('./sales-access.feature', { loadRelativePath: true });
const API = '/api/v1';

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let leads: Repository<LeadEntity>;
  let stages: Repository<PipelineStageEntity>;
  const orgIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    leads = h.app.get(getRepositoryToken(LeadEntity));
    stages = h.app.get(getRepositoryToken(PipelineStageEntity));
  });
  afterAll(async () => {
    const ids = [...orgIds];
    if (ids.length) {
      await leads.delete({ organizationId: In(ids) }).catch(() => undefined);
      await stages.delete({ organizationId: In(ids) }).catch(() => undefined);
    }
    await h.cleanup();
  });

  const as = (token: string) => ({
    get: (path: string) => h.api().get(`${API}${path}`).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) =>
      h.api().post(`${API}${path}`).set('Authorization', `Bearer ${token}`).send(body),
    del: (path: string) => h.api().delete(`${API}${path}`).set('Authorization', `Bearer ${token}`),
  });

  const newOrg = async (): Promise<CreatedOrg> => {
    const o = await h.createOrg();
    orgIds.add(o.orgId);
    return o;
  };

  /** A member holding a custom "Sales Rep" role that grants sales view/create/edit/export — no delete. */
  const createSalesRep = async (o: CreatedOrg): Promise<string> => {
    const role = await as(o.ownerToken)
      .post('/org/roles', {
        name: `sales-rep-${Date.now()}`,
        displayName: 'Sales Rep',
        permissions: [{ resource: 'sales', actions: ['view', 'create', 'edit', 'export'] }],
      })
      .expect(201);
    const email = randomEmail('rep');
    const added = await as(o.ownerToken)
      .post('/org/members', { email, roleId: role.body.data.id, firstName: 'Rhea', lastName: 'Rep' })
      .expect(201);
    h.trackUser(added.body.data.userId);
    return h.mintToken(email); // the token now carries the role's sales grant
  };

  test('a member with no sales grant cannot reach leads', ({ given, when, then, and }) => {
    let member: { token: string };
    let res: request.Response;

    given('an organization with a member who has no sales permission', async () => {
      member = await h.createEmployeeMember(await newOrg());
    });
    when('that member lists the leads', async () => {
      res = await as(member.token).get('/sales/leads');
    });
    then('the request is forbidden', () => {
      expect(res.status).toBe(403);
    });
    and('exporting the leads is forbidden too', async () => {
      expect((await as(member.token).get('/sales/leads/export')).status).toBe(403);
    });
  });

  test('a sales rep can work leads but only within their grant', ({ given, when, then, and, but }) => {
    let repToken: string;
    let created: request.Response;
    let listed: request.Response;

    given('an organization with a sales rep who may view, create, edit and export leads', async () => {
      repToken = await createSalesRep(await newOrg());
    });
    when('the rep creates a lead and lists the leads', async () => {
      created = await as(repToken).post('/sales/leads', { name: 'Priya Nair', company: 'Acme Retail' });
      listed = await as(repToken).get('/sales/leads');
    });
    then('the lead is created and appears in the list', () => {
      expect(created.status).toBe(201);
      expect(listed.status).toBe(200);
      expect(listed.body.data.map((l: any) => l.id)).toContain(created.body.data.id);
    });
    and('the rep can export the leads', async () => {
      expect((await as(repToken).get('/sales/leads/export')).status).toBe(200);
    });
    but('the rep cannot delete the lead', async () => {
      const res = await as(repToken).del(`/sales/leads/${created.body.data.id}`);
      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/permission to delete sales/);
    });
  });

  test('the owner can do everything, including delete', ({ given, when, then }) => {
    let o: CreatedOrg;
    let repToken: string;
    let created: request.Response;

    given('an organization with a sales rep who may view, create, edit and export leads', async () => {
      o = await newOrg();
      repToken = await createSalesRep(o);
    });
    when('the rep creates a lead and lists the leads', async () => {
      created = await as(repToken).post('/sales/leads', { name: 'Owen Byers', company: 'Byers & Co' });
      await as(repToken).get('/sales/leads').expect(200);
    });
    then('the owner can delete that lead', async () => {
      expect(created.status).toBe(201);
      expect((await as(o.ownerToken).del(`/sales/leads/${created.body.data.id}`)).status).toBe(200);
    });
  });

  test('reshaping the pipeline stays with owners and admins', ({ given, when, then, and }) => {
    let o: CreatedOrg;
    let repToken: string;
    let res: request.Response;

    given('an organization with a sales rep who may view, create, edit and export leads', async () => {
      o = await newOrg();
      repToken = await createSalesRep(o);
    });
    when('the rep tries to add a pipeline stage', async () => {
      res = await as(repToken).post('/sales/stages', { name: 'Negotiation' });
    });
    then('the request is forbidden', () => {
      expect(res.status).toBe(403);
    });
    and('the owner can add a pipeline stage', async () => {
      expect((await as(o.ownerToken).post('/sales/stages', { name: 'Negotiation' })).status).toBe(201);
    });
  });
});
