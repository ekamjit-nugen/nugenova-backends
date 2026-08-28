import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import request from 'supertest';

import {
  bootOrgTestApp,
  OrgTestHarness,
  CreatedOrg,
} from '../../organization/features/support/org-harness';
import { NotificationEntity } from '../entities/notification.entity';
import { WfhRequestEntity } from '../../attendance/entities/wfh-request.entity';

const feature = loadFeature('./notification.feature', { loadRelativePath: true });
const API = '/api/v1';

/** A future calendar day (YYYY-MM-DD) in IST — a WFH request must not be past. */
function istDay(delta = 1): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
    new Date(Date.now() + delta * 86_400_000),
  );
}

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let notifs: Repository<NotificationEntity>;
  let wfh: Repository<WfhRequestEntity>;
  const orgIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    notifs = h.app.get(getRepositoryToken(NotificationEntity));
    wfh = h.app.get(getRepositoryToken(WfhRequestEntity));
  });
  afterAll(async () => {
    const ids = [...orgIds];
    if (ids.length) {
      await notifs.delete({ organizationId: In(ids) }).catch(() => undefined);
      await wfh.delete({ organizationId: In(ids) }).catch(() => undefined);
    }
    await h.cleanup();
  });

  const requestWfh = (token: string, body: any) =>
    h.api().post(`${API}/attendance/wfh-requests`).set('Authorization', `Bearer ${token}`).send(body);
  const review = (token: string, id: string, approved: boolean) =>
    h.api().put(`${API}/attendance/wfh-requests/${id}/review`).set('Authorization', `Bearer ${token}`).send({ approved });
  const listNotifs = (token: string, unreadOnly = false) =>
    h.api().get(`${API}/notifications${unreadOnly ? '?unreadOnly=true' : ''}`).set('Authorization', `Bearer ${token}`);
  const unreadCount = (token: string) =>
    h.api().get(`${API}/notifications/unread-count`).set('Authorization', `Bearer ${token}`);
  const markRead = (token: string, id: string) =>
    h.api().post(`${API}/notifications/${id}/read`).set('Authorization', `Bearer ${token}`);
  const markAllRead = (token: string) =>
    h.api().post(`${API}/notifications/read-all`).set('Authorization', `Bearer ${token}`);
  const clearRead = (token: string) =>
    h.api().post(`${API}/notifications/clear-read`).set('Authorization', `Bearer ${token}`);

  const setup = async () => {
    const org = await h.createOrg();
    orgIds.add(org.orgId);
    const emp1 = await h.createEmployeeMember(org);
    const emp2 = await h.createEmployeeMember(org);
    return { org, emp1, emp2 };
  };

  type Ctx = Awaited<ReturnType<typeof setup>>;
  let ctx: Ctx;
  let reqId: string;
  let res: request.Response;

  const bg = (given: any) =>
    given('an organization with an owner and two employees', async () => {
      ctx = await setup();
    });

  const makePending = async () => {
    const r = await requestWfh(ctx.emp1.token, { startDate: istDay(1) }).expect(201);
    reqId = r.body.data.id;
  };

  const findByType = (body: any, type: string) =>
    (body.items || []).find((n: any) => n.type === type);

  test('a new request notifies the approvers but not the requester or bystanders', ({
    given,
    when,
    then,
    and,
  }) => {
    bg(given);
    when('the first employee requests work-from-home', makePending);
    then('the owner has an unread "wfh_request_submitted" notification', async () => {
      const owner = await listNotifs(ctx.org.ownerToken).expect(200);
      const n = findByType(owner.body, 'wfh_request_submitted');
      expect(n).toBeTruthy();
      expect(n.read).toBe(false);
    });
    and('the requesting employee has no notifications', async () => {
      const mine = await listNotifs(ctx.emp1.token).expect(200);
      expect(mine.body.items.length).toBe(0);
    });
    and('the second employee has no notifications', async () => {
      const other = await listNotifs(ctx.emp2.token).expect(200);
      expect(other.body.items.length).toBe(0);
    });
  });

  test('reviewing a request notifies the requester and is tracked with a route', ({
    given,
    when,
    then,
    and,
  }) => {
    bg(given);
    given('the first employee has a pending WFH request', makePending);
    when('the owner approves the request', async () => {
      res = await review(ctx.org.ownerToken, reqId, true).expect(200);
    });
    then('the first employee has a "wfh_request_reviewed" notification', async () => {
      const mine = await listNotifs(ctx.emp1.token).expect(200);
      expect(findByType(mine.body, 'wfh_request_reviewed')).toBeTruthy();
    });
    and('that notification carries an actionUrl to the attendance page', async () => {
      const mine = await listNotifs(ctx.emp1.token).expect(200);
      const n = findByType(mine.body, 'wfh_request_reviewed');
      expect(n.data.actionUrl).toBe('/attendance');
    });
  });

  test('a user only sees their own notifications', ({ given, when, then, and }) => {
    bg(given);
    given('the first employee has a pending WFH request', makePending);
    when('the owner approves the request', async () => {
      await review(ctx.org.ownerToken, reqId, true).expect(200);
    });
    then("the owner's inbox does not contain the review notification", async () => {
      const owner = await listNotifs(ctx.org.ownerToken).expect(200);
      expect(findByType(owner.body, 'wfh_request_reviewed')).toBeFalsy();
    });
    and("the first employee's inbox does not contain the submission notification", async () => {
      const mine = await listNotifs(ctx.emp1.token).expect(200);
      expect(findByType(mine.body, 'wfh_request_submitted')).toBeFalsy();
    });
  });

  test("another user cannot mark someone else's notification read", ({
    given,
    when,
    then,
    and,
  }) => {
    bg(given);
    given('the first employee has a pending WFH request', makePending);
    let ownerNotifId: string;
    and('the owner has an unread submission notification', async () => {
      const owner = await listNotifs(ctx.org.ownerToken).expect(200);
      ownerNotifId = findByType(owner.body, 'wfh_request_submitted').id;
    });
    when("the first employee tries to mark the owner's notification read", async () => {
      // Scoped by the caller's userId → a no-op for a foreign id (still 200).
      await markRead(ctx.emp1.token, ownerNotifId!).expect(200);
    });
    then("the owner's notification is still unread", async () => {
      const owner = await listNotifs(ctx.org.ownerToken).expect(200);
      const n = (owner.body.items as any[]).find((x) => x.id === ownerNotifId);
      expect(n.read).toBe(false);
    });
  });

  test('a recipient can mark their notifications read and clear them', ({
    given,
    when,
    then,
    and,
  }) => {
    bg(given);
    given('the first employee has a pending WFH request', makePending);
    and('the owner has an unread submission notification', async () => {
      const c = await unreadCount(ctx.org.ownerToken).expect(200);
      expect(c.body.data.count).toBeGreaterThanOrEqual(1);
    });
    when('the owner marks all notifications read', async () => {
      await markAllRead(ctx.org.ownerToken).expect(200);
    });
    then("the owner's unread count is zero", async () => {
      const c = await unreadCount(ctx.org.ownerToken).expect(200);
      expect(c.body.data.count).toBe(0);
    });
    and('the owner can clear read notifications so the panel is empty', async () => {
      await clearRead(ctx.org.ownerToken).expect(200);
      const owner = await listNotifs(ctx.org.ownerToken).expect(200);
      expect(owner.body.items.length).toBe(0);
    });
  });

  test('notifications require authentication', ({ given, when, then }) => {
    bg(given);
    when('an unauthenticated client requests the notifications list', async () => {
      res = await h.api().get(`${API}/notifications`);
    });
    then('the request is rejected as unauthorized', () => {
      expect(res.status).toBe(401);
    });
  });
});
