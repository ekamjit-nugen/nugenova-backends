import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import {
  bootOrgTestApp,
  OrgTestHarness,
  CreatedOrg,
} from '../../organization/features/support/org-harness';
import { NotificationEntity } from '../entities/notification.entity';
import { NotificationPreferenceEntity } from '../entities/notification-preference.entity';
import { WfhRequestEntity } from '../../attendance/entities/wfh-request.entity';

const feature = loadFeature('./notification-preferences.feature', { loadRelativePath: true });
const API = '/api/v1';

function istDay(delta = 1): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
    new Date(Date.now() + delta * 86_400_000),
  );
}

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let notifs: Repository<NotificationEntity>;
  let prefs: Repository<NotificationPreferenceEntity>;
  let wfh: Repository<WfhRequestEntity>;
  const orgIds = new Set<string>();
  const userIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    notifs = h.app.get(getRepositoryToken(NotificationEntity));
    prefs = h.app.get(getRepositoryToken(NotificationPreferenceEntity));
    wfh = h.app.get(getRepositoryToken(WfhRequestEntity));
  });
  afterAll(async () => {
    const oids = [...orgIds];
    const uids = [...userIds];
    if (oids.length) {
      await notifs.delete({ organizationId: In(oids) }).catch(() => undefined);
      await wfh.delete({ organizationId: In(oids) }).catch(() => undefined);
    }
    if (uids.length) await prefs.delete({ userId: In(uids) }).catch(() => undefined);
    await h.cleanup();
  });

  const requestWfh = (token: string) =>
    h.api().post(`${API}/attendance/wfh-requests`).set('Authorization', `Bearer ${token}`).send({ startDate: istDay(1) });
  const review = (token: string, id: string) =>
    h.api().put(`${API}/attendance/wfh-requests/${id}/review`).set('Authorization', `Bearer ${token}`).send({ approved: true });
  const getPrefs = (token: string) =>
    h.api().get(`${API}/notifications/preferences`).set('Authorization', `Bearer ${token}`);
  const putPrefs = (token: string, body: any) =>
    h.api().put(`${API}/notifications/preferences`).set('Authorization', `Bearer ${token}`).send(body);
  const list = (token: string) =>
    h.api().get(`${API}/notifications`).set('Authorization', `Bearer ${token}`);
  const has = (body: any, type: string) => (body.items || []).some((n: any) => n.type === type);

  const setup = async () => {
    const org = await h.createOrg();
    orgIds.add(org.orgId);
    userIds.add(org.ownerId);
    const emp = await h.createEmployeeMember(org);
    userIds.add(emp.userId);
    return { org, emp };
  };

  type Ctx = Awaited<ReturnType<typeof setup>>;
  let ctx: Ctx;
  let res: any;
  let reqId: string;

  const bg = (given: any) =>
    given('an organization with an owner and an employee', async () => {
      ctx = await setup();
    });

  test('preferences default to everything on', ({ given, when, then }) => {
    bg(given);
    when('the owner reads their notification preferences', async () => {
      res = await getPrefs(ctx.org.ownerToken).expect(200);
    });
    then('in-app is on and every category is on', () => {
      const d = res.body.data;
      expect(d.inApp).toBe(true);
      expect(d.categories.attendance).toBe(true);
      expect(d.categories.onboarding).toBe(true);
      expect(d.categories.policy).toBe(true);
    });
  });

  test('turning off a category stops those notifications', ({ given, when, then }) => {
    bg(given);
    given('the owner turns off the attendance category', async () => {
      await putPrefs(ctx.org.ownerToken, { categories: { attendance: false } }).expect(200);
    });
    when('the employee submits a work-from-home request', async () => {
      await requestWfh(ctx.emp.token).expect(201);
    });
    then('the owner receives no work-from-home notification', async () => {
      const owner = await list(ctx.org.ownerToken).expect(200);
      expect(has(owner.body, 'wfh_request_submitted')).toBe(false);
    });
  });

  test('Do Not Disturb suppresses a non-urgent notification', ({ given, when, then }) => {
    bg(given);
    given('the owner enables Do Not Disturb', async () => {
      await putPrefs(ctx.org.ownerToken, { dndEnabled: true }).expect(200);
    });
    when('the employee submits a work-from-home request', async () => {
      await requestWfh(ctx.emp.token).expect(201);
    });
    then('the owner receives no work-from-home notification', async () => {
      const owner = await list(ctx.org.ownerToken).expect(200);
      expect(has(owner.body, 'wfh_request_submitted')).toBe(false);
    });
  });

  test('Do Not Disturb still lets an urgent notification through', ({ given, and, when, then }) => {
    bg(given);
    given('the employee enables Do Not Disturb allowing urgent', async () => {
      await putPrefs(ctx.emp.token, { dndEnabled: true, dndAllowUrgent: true }).expect(200);
    });
    and('the employee has a pending work-from-home request', async () => {
      const r = await requestWfh(ctx.emp.token).expect(201);
      reqId = r.body.data.id;
    });
    when('the owner approves the request', async () => {
      await review(ctx.org.ownerToken, reqId).expect(200);
    });
    then('the employee still receives the approval notification', async () => {
      const mine = await list(ctx.emp.token).expect(200);
      expect(has(mine.body, 'wfh_request_reviewed')).toBe(true);
    });
  });
});
