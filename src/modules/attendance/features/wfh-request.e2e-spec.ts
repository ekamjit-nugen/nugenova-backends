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
import { AttendanceEntity } from '../entities/attendance.entity';
import { WfhRequestEntity } from '../entities/wfh-request.entity';
import { PolicyEntity } from '../../policy/entities/policy.entity';

const feature = loadFeature('./wfh-request.feature', { loadRelativePath: true });
const API = '/api/v1';

const OFFICE = { latitude: 12.9716, longitude: 77.5946 }; // Bengaluru
const FAR = { latitude: 13.0827, longitude: 80.2707 }; // Chennai (~290 km)

/** Today's / a delta day's calendar date (YYYY-MM-DD) in the org tz (IST). */
function istDay(delta = 0): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
    new Date(Date.now() + delta * 86_400_000),
  );
}

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let attendance: Repository<AttendanceEntity>;
  let wfh: Repository<WfhRequestEntity>;
  let policies: Repository<PolicyEntity>;
  const orgIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    attendance = h.app.get(getRepositoryToken(AttendanceEntity));
    wfh = h.app.get(getRepositoryToken(WfhRequestEntity));
    policies = h.app.get(getRepositoryToken(PolicyEntity));
  });
  afterAll(async () => {
    const ids = [...orgIds];
    if (ids.length) {
      await attendance.delete({ organizationId: In(ids) }).catch(() => undefined);
      await wfh.delete({ organizationId: In(ids) }).catch(() => undefined);
      await policies.delete({ organizationId: In(ids) }).catch(() => undefined);
    }
    await h.cleanup();
  });

  const clockIn = (token: string, body: any = {}) =>
    h.api().post(`${API}/attendance/check-in`).set('Authorization', `Bearer ${token}`).send(body);
  const requestWfh = (token: string, body: any) =>
    h.api().post(`${API}/attendance/wfh-requests`).set('Authorization', `Bearer ${token}`).send(body);
  const listMine = (token: string) =>
    h.api().get(`${API}/attendance/wfh-requests/mine`).set('Authorization', `Bearer ${token}`);
  const listPending = (token: string) =>
    h.api().get(`${API}/attendance/wfh-requests/pending`).set('Authorization', `Bearer ${token}`);
  const review = (token: string, id: string, approved: boolean) =>
    h.api().put(`${API}/attendance/wfh-requests/${id}/review`).set('Authorization', `Bearer ${token}`).send({ approved });

  // Fresh org (office geo-fence policy applicable to all) + an employee.
  const setup = async () => {
    const org = await h.createOrg();
    orgIds.add(org.orgId);
    // Drop the auto-seeded work-timing default so the office policy wins.
    await policies.delete({ organizationId: org.orgId, applicableTo: 'all' });
    await h
      .api()
      .post(`${API}/policies`)
      .set('Authorization', `Bearer ${org.ownerToken}`)
      .send({
        isActive: true,
        policyName: 'Office',
        category: 'attendance',
        applicableTo: 'all',
        workTiming: { startTime: '00:00', endTime: '23:59', timezone: 'Asia/Kolkata' },
        workLocation: { mode: 'office', geoFenceRadiusKm: 2, offices: [{ name: 'HQ', ...OFFICE }] },
      })
      .expect(201);
    const email = randomEmail('emp');
    const member = await h
      .api()
      .post(`${API}/org/members`)
      .set('Authorization', `Bearer ${org.ownerToken}`)
      .send({ email, role: 'employee', firstName: 'Emp', lastName: 'Loyee' })
      .expect(201);
    const userId = member.body.data.userId;
    h.trackUser(userId);
    const token = await h.mintToken(email);
    return { org, userId, token };
  };

  let ctx: Awaited<ReturnType<typeof setup>>;
  let reqId: string;
  let res: request.Response;

  const bg = (given: any) =>
    given('an organization with an office geo-fence policy and an employee', async () => {
      ctx = await setup();
    });
  const givenPending = async () => {
    const r = await requestWfh(ctx.token, { startDate: istDay(0) }).expect(201);
    reqId = r.body.data.id;
  };

  test('an employee raises a WFH request that starts pending', ({ given, when, then, and }) => {
    bg(given);
    when('the employee requests work-from-home for today', async () => {
      res = await requestWfh(ctx.token, { startDate: istDay(0), reason: 'Plumber visit' });
    });
    then('the request is created with status pending', () => {
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('pending');
    });
    and("it appears in the employee's WFH requests", async () => {
      const mine = await listMine(ctx.token).expect(200);
      expect(mine.body.data.map((r: any) => r.id)).toContain(res.body.data.id);
    });
  });

  test('an owner approves a WFH request', ({ given, and, when, then }) => {
    bg(given);
    given('the employee has a pending WFH request for today', givenPending);
    when('the owner approves the request', async () => {
      res = await review(ctx.org.ownerToken, reqId, true);
    });
    then('the request status is approved', () => {
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('approved');
    });
    and('the request appears in the pending queue before approval but not after', async () => {
      const after = await listPending(ctx.org.ownerToken).expect(200);
      expect(after.body.data.map((r: any) => r.id)).not.toContain(reqId);
    });
  });

  test('an approved WFH day lets the employee clock in from anywhere', ({ given, when, then }) => {
    bg(given);
    given('the employee has an approved WFH request for today', async () => {
      await givenPending();
      await review(ctx.org.ownerToken, reqId, true).expect(200);
    });
    when('the employee clocks in from outside the office', async () => {
      res = await clockIn(ctx.token, { location: FAR });
    });
    then('the clock-in succeeds and is recorded as work-from-home', () => {
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('wfh');
    });
  });

  test('without approval an office clock-in is still geo-fenced', ({ given, when, then }) => {
    bg(given);
    when('the employee clocks in from outside the office with no WFH approval', async () => {
      res = await clockIn(ctx.token, { location: FAR });
    });
    then('the clock-in is rejected', () => {
      expect(res.status).toBe(400);
    });
  });

  test('an owner rejects a WFH request', ({ given, and, when, then }) => {
    bg(given);
    given('the employee has a pending WFH request for today', givenPending);
    when('the owner rejects the request', async () => {
      res = await review(ctx.org.ownerToken, reqId, false);
    });
    then('the request status is rejected', () => {
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('rejected');
    });
    and('a clock-in from outside the office is rejected', async () => {
      const clock = await clockIn(ctx.token, { location: FAR });
      expect(clock.status).toBe(400);
    });
  });

  test('an employee cancels a pending WFH request', ({ given, when, then }) => {
    bg(given);
    given('the employee has a pending WFH request for today', givenPending);
    when('the employee cancels the request', async () => {
      res = await h
        .api()
        .post(`${API}/attendance/wfh-requests/${reqId}/cancel`)
        .set('Authorization', `Bearer ${ctx.token}`);
    });
    then('the request no longer appears in their WFH requests', async () => {
      expect(res.status).toBe(200);
      const mine = await listMine(ctx.token).expect(200);
      expect(mine.body.data.map((r: any) => r.id)).not.toContain(reqId);
    });
  });

  test('a WFH request for past dates is refused', ({ given, when, then }) => {
    bg(given);
    when('the employee requests work-from-home for yesterday', async () => {
      res = await requestWfh(ctx.token, { startDate: istDay(-1) });
    });
    then('the WFH request is rejected as a bad request', () => {
      expect(res.status).toBe(400);
    });
  });

  test('an employee cannot review WFH requests', ({ given, when, then }) => {
    bg(given);
    given('the employee has a pending WFH request for today', givenPending);
    when('the employee tries to approve their own request', async () => {
      res = await review(ctx.token, reqId, true);
    });
    then('the review is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });
});
