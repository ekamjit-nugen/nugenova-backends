import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import request from 'supertest';

import {
  bootOrgTestApp,
  OrgTestHarness,
  CreatedOrg,
} from '../../organization/features/support/org-harness';
import { RoleEntity } from '../../auth/entities/role.entity';
import { EDUCATION_ROLE_NAMES } from '../../organization/default-roles';

const feature = loadFeature('./vertical.feature', { loadRelativePath: true });
const API = '/api/v1';

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let roles: Repository<RoleEntity>;

  beforeAll(async () => {
    h = await bootOrgTestApp();
    roles = h.app.get(getRepositoryToken(RoleEntity));
  });
  afterAll(async () => {
    await h.cleanup();
  });

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  test('a new org resolves the company pack by default', ({ given, when, then }) => {
    let o: CreatedOrg;
    let res: request.Response;
    given('a newly provisioned organization', async () => {
      o = await h.createOrg();
    });
    when('its owner reads the vertical pack', async () => {
      res = await h
        .api()
        .get(`${API}/vertical/pack`)
        .set(auth(o.ownerToken))
        .expect(200);
    });
    then('the pack orgType is company and enables no education modules', () => {
      expect(res.body.data.orgType).toBe('company');
      expect(res.body.data.enabledModules).not.toContain('lms');
      expect(res.body.data.vocabulary.Member).toBe('Employee');
    });
  });

  test('an admin switches the org to a school vertical', ({ given, when, then, and }) => {
    let o: CreatedOrg;
    let res: request.Response;
    given('a newly provisioned organization', async () => {
      o = await h.createOrg();
    });
    when('the owner sets the org type to school', async () => {
      res = await h
        .api()
        .put(`${API}/vertical`)
        .set(auth(o.ownerToken))
        .send({ orgType: 'school' })
        .expect(200);
    });
    then('the resolved pack relabels members as students and enables the lms module', () => {
      expect(res.body.data.orgType).toBe('school');
      expect(res.body.data.vocabulary.Member).toBe('Student');
      expect(res.body.data.enabledModules).toContain('lms');
      expect(res.body.data.aiTierCeiling).toBe(1);
    });
    and('the education roles are seeded for the org', async () => {
      const seeded = await roles.find({
        where: { organizationId: o.orgId, isDeleted: false },
      });
      const names = new Set(seeded.map((r) => r.name));
      for (const eduRole of EDUCATION_ROLE_NAMES) {
        expect(names.has(eduRole)).toBe(true);
      }
    });
  });

  test('an employee cannot repack the org', ({ given, when, then }) => {
    let o: CreatedOrg;
    let emp: { token: string };
    let res: request.Response;
    given('an organization with an employee', async () => {
      o = await h.createOrg();
      emp = await h.createEmployeeMember(o);
    });
    when('the employee tries to set the org type', async () => {
      res = await h
        .api()
        .put(`${API}/vertical`)
        .set(auth(emp.token))
        .send({ orgType: 'school' });
    });
    then('the request is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  test('an override can only lower the AI tier ceiling', ({ given, when, then }) => {
    let o: CreatedOrg;
    let res: request.Response;
    given('a school organization', async () => {
      o = await h.createOrg();
      await h
        .api()
        .put(`${API}/vertical`)
        .set(auth(o.ownerToken))
        .send({ orgType: 'school' })
        .expect(200);
    });
    when('the owner tries to raise its AI tier ceiling to three', async () => {
      res = await h
        .api()
        .put(`${API}/vertical`)
        .set(auth(o.ownerToken))
        .send({ verticalPack: { aiTierCeiling: 3 } })
        .expect(200);
    });
    then('the resolved ceiling stays capped at one', () => {
      expect(res.body.data.aiTierCeiling).toBe(1);
    });
  });
});
