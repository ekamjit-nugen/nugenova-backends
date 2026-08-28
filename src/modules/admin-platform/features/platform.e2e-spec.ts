import { defineFeature, loadFeature } from 'jest-cucumber';
import request from 'supertest';

import {
  bootOrgTestApp,
  OrgTestHarness,
  CreatedOrg,
} from '../../organization/features/support/org-harness';

const feature = loadFeature('./platform.feature', { loadRelativePath: true });
const API = '/api/v1';

defineFeature(feature, (test) => {
  let h: OrgTestHarness;

  beforeAll(async () => {
    h = await bootOrgTestApp();
  });
  afterAll(async () => {
    await h.cleanup();
  });

  const usage = (token: string) =>
    h.api().get(`${API}/admin/platform/usage`).set('Authorization', `Bearer ${token}`);

  test('the super admin sees platform usage', ({ given, when, then, and }) => {
    let saToken: string;
    let res: request.Response;
    given('a platform super admin', async () => {
      const sa = await h.createSuperAdmin();
      saToken = sa.token;
    });
    when('they request the platform usage overview', async () => {
      res = await usage(saToken);
    });
    then('the overview reports organization, user and member totals', () => {
      expect(res.status).toBe(200);
      const d = res.body.data;
      expect(typeof d.organizations.total).toBe('number');
      expect(typeof d.users.total).toBe('number');
      expect(typeof d.members.total).toBe('number');
      expect(d.features).toBeDefined();
    });
    and('it lists per-organization usage', () => {
      expect(Array.isArray(res.body.data.perOrg)).toBe(true);
    });
  });

  test('an organization owner cannot see platform usage', ({ given, when, then }) => {
    let org: CreatedOrg;
    let res: request.Response;
    given('an organization and its owner', async () => {
      org = await h.createOrg();
    });
    when('the owner requests the platform usage overview', async () => {
      res = await usage(org.ownerToken);
    });
    then('the request is forbidden', () => {
      expect(res.status).toBe(403);
    });
  });
});
