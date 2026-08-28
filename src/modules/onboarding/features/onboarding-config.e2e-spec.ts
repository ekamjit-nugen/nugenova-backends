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

  test('the owner reads the document catalog', ({ given, when, then }) => {
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
