import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import request from 'supertest';

import {
  bootOrgTestApp,
  OrgTestHarness,
  CreatedOrg,
} from '../../organization/features/support/org-harness';
import { PolicyEntity } from '../../policy/entities/policy.entity';

const feature = loadFeature('./onboarding-config.feature', {
  loadRelativePath: true,
});
const API = '/api/v1';

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let policies: Repository<PolicyEntity>;
  const orgIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    policies = h.app.get(getRepositoryToken(PolicyEntity));
  });
  afterAll(async () => {
    const ids = [...orgIds];
    if (ids.length) {
      await policies.delete({ organizationId: In(ids) }).catch(() => undefined);
    }
    await h.cleanup();
  });

  const org = async () => {
    const o = await h.createOrg();
    orgIds.add(o.orgId);
    return o;
  };
  const getConfig = (o: CreatedOrg, token = o.ownerToken) =>
    h.api()
      .get(`${API}/policies/onboarding-config`)
      .set('Authorization', `Bearer ${token}`);
  const putConfig = (o: CreatedOrg, body: any, token = o.ownerToken) =>
    h.api()
      .put(`${API}/policies/onboarding-config`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  test('the default onboarding config falls back to catalog defaults', ({
    given,
    when,
    then,
  }) => {
    let o: CreatedOrg;
    let res: request.Response;
    given('a freshly provisioned organization', async () => {
      o = await org();
    });
    when('the owner reads the onboarding config', async () => {
      res = await getConfig(o);
    });
    then(
      'the config lists the default required documents and a checklist',
      () => {
        expect(res.status).toBe(200);
        expect(res.body.data.documents.length).toBeGreaterThan(0);
        expect(res.body.data.checklist.length).toBeGreaterThan(0);
        expect(res.body.data.defaultProbationMonths).toBeGreaterThan(0);
        expect(res.body.data.targetDays).toBeGreaterThan(0);
      },
    );
  });

  test('the owner reads the document catalog', ({ given, when, then, and }) => {
    let o: CreatedOrg;
    let res: request.Response;
    given('a freshly provisioned organization', async () => {
      o = await org();
    });
    when('the owner reads the onboarding catalog', async () => {
      res = await h
        .api()
        .get(`${API}/policies/onboarding-catalog`)
        .set('Authorization', `Bearer ${o.ownerToken}`);
    });
    then('the catalog groups documents and includes the defaults', () => {
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.documents)).toBe(true);
      const groups = res.body.data.documents.map((g: any) => g.group);
      expect(groups).toContain('Identity');
      expect(res.body.data.defaults.documents.length).toBeGreaterThan(0);
    });
    and('the catalog lists the selectable standard checklist tasks', () => {
      expect(Array.isArray(res.body.data.checklist)).toBe(true);
      const keys = res.body.data.checklist.map((c: any) => c.key);
      expect(keys).toEqual(
        expect.arrayContaining(['welcome_read', 'it_accounts', 'intro_meeting']),
      );
      // each carries a human hint on how it completes
      expect(res.body.data.checklist.every((c: any) => !!c.completedBy)).toBe(true);
    });
  });

  test('the owner selects which standard checklist tasks apply', ({
    given,
    when,
    then,
    and,
  }) => {
    let o: CreatedOrg;
    given('a freshly provisioned organization', async () => {
      o = await org();
    });
    when('the owner saves a checklist without the team-introduction task', async () => {
      // Read the catalog, drop intro_meeting, save the rest.
      const cat = await h
        .api()
        .get(`${API}/policies/onboarding-catalog`)
        .set('Authorization', `Bearer ${o.ownerToken}`)
        .expect(200);
      const selection = (cat.body.data.checklist as any[])
        .filter((c) => c.key !== 'intro_meeting')
        .map((c) => ({ key: c.key }));
      await putConfig(o, { checklist: selection }).expect(200);
    });
    then('reading the config back omits the team-introduction task', async () => {
      const back = await getConfig(o).expect(200);
      const keys = (back.body.data.checklist as any[]).map((c) => c.key);
      expect(keys).not.toContain('intro_meeting');
    });
    and('the retained standard tasks keep their canonical keys', async () => {
      const back = await getConfig(o).expect(200);
      const it = (back.body.data.checklist as any[]).find((c) => c.key === 'it_accounts');
      // canonicalised from just {key} → full title/category/assignee restored
      expect(it).toMatchObject({
        key: 'it_accounts',
        title: 'Provision IT accounts & email',
        category: 'it_setup',
        assignedTo: 'it',
      });
    });
  });

  test('the owner customises the onboarding requirements', ({
    given,
    when,
    then,
  }) => {
    let o: CreatedOrg;
    let res: request.Response;
    given('a freshly provisioned organization', async () => {
      o = await org();
    });
    when(
      'the owner saves a config requiring a passport and a six-month probation',
      async () => {
        res = await putConfig(o, {
          documents: [
            { key: 'photo_id', title: 'Government Photo ID', required: true },
            { key: 'passport', title: 'Passport', required: true },
          ],
          defaultProbationMonths: 6,
          targetDays: 21,
        });
        expect(res.status).toBe(200);
      },
    );
    then(
      'reading the config back reflects the passport requirement and probation',
      async () => {
        const back = await getConfig(o);
        const keys = back.body.data.documents.map((d: any) => d.key);
        expect(keys).toContain('passport');
        expect(back.body.data.defaultProbationMonths).toBe(6);
        expect(back.body.data.targetDays).toBe(21);
      },
    );
  });

  test('an employee cannot edit the onboarding config', ({
    given,
    when,
    then,
  }) => {
    let empToken: string;
    let o: CreatedOrg;
    let res: request.Response;
    given(
      'a freshly provisioned organization with an employee member',
      async () => {
        o = await org();
        empToken = (await h.createEmployeeMember(o)).token;
      },
    );
    when('the employee tries to save the onboarding config', async () => {
      res = await putConfig(o, { targetDays: 30 }, empToken);
    });
    then('the config write is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });
});
