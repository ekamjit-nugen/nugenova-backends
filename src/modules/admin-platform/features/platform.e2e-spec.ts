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
    then('the overview reports account, security and infrastructure signals', () => {
      expect(res.status).toBe(200);
      const d = res.body.data;
      // accounts + seats
      expect(typeof d.organizations.total).toBe('number');
      expect(typeof d.users.total).toBe('number');
      expect(typeof d.members.total).toBe('number');
      // communications infra (throughput only)
      expect(typeof d.communications.emails.sent).toBe('number');
      expect(typeof d.communications.emails.failed).toBe('number');
      expect(typeof d.communications.notifications.total).toBe('number');
      // security posture
      expect(typeof d.security.mfaEnabled).toBe('number');
      expect(typeof d.security.mfaAdoption).toBe('number');
      expect(typeof d.security.emailVerified).toBe('number');
      expect(typeof d.security.sessions.active).toBe('number');
    });
    and('it exposes no tenant business data', () => {
      const d = res.body.data;
      // The super admin must not see inside any org: no payroll/leave/policy/
      // attendance/onboarding aggregates, and no notification-category breakdown.
      expect(d.features).toBeUndefined();
      expect(d.communications.notifications.byCategory).toBeUndefined();
      // per-org rows carry only account-level fields (seats, status), never
      // tenant record counts.
      const row = (d.perOrg as any[])[0];
      if (row) {
        expect(row.policies).toBeUndefined();
        expect(row.payslips).toBeUndefined();
        expect(row.leaveRequests).toBeUndefined();
        expect(row.attendanceRecords).toBeUndefined();
        expect(typeof row.members).toBe('number');
      }
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
