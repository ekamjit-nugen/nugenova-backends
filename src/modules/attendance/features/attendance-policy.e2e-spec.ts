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
import { PolicyEntity } from '../../policy/entities/policy.entity';

const feature = loadFeature('./attendance-policy.feature', { loadRelativePath: true });
const API = '/api/v1';

/**
 * Deterministic timing: pick an Etc/GMT zone in which "now" is ~midday, so a
 * policy start time set a few minutes before/after now never crosses local
 * midnight. Etc/GMT+N == UTC-N (the sign is inverted by design).
 */
function noonTz(): string {
  const h = new Date().getUTCHours();
  const off = h - 12; // hours to subtract from UTC to land at ~noon
  if (off === 0) return 'UTC';
  return off > 0 ? `Etc/GMT+${off}` : `Etc/GMT${off}`; // off<0 → Etc/GMT-2 (=UTC+2)
}
function hhmmInTz(instant: Date, tz: string): string {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(instant);
  const h = p.find((x) => x.type === 'hour')!.value.replace('24', '00');
  const m = p.find((x) => x.type === 'minute')!.value;
  return `${h}:${m}`;
}
/** Today's weekday name in the org tz (IST — the day-bounds tz). */
function weekdayIST(delta = 0): string {
  const d = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    weekday: 'long',
  }).format(new Date(Date.now() + delta * 86_400_000));
  return d.toLowerCase();
}

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let attendance: Repository<AttendanceEntity>;
  let policies: Repository<PolicyEntity>;
  const orgIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    attendance = h.app.get(getRepositoryToken(AttendanceEntity));
    policies = h.app.get(getRepositoryToken(PolicyEntity));
  });
  afterAll(async () => {
    const ids = [...orgIds];
    if (ids.length) {
      await attendance.delete({ organizationId: In(ids) }).catch(() => undefined);
      await policies.delete({ organizationId: In(ids) }).catch(() => undefined);
    }
    await h.cleanup();
  });

  // A fresh org (default policy auto-seeded) + a department + an employee in it.
  const setup = async () => {
    const org = await h.createOrg();
    orgIds.add(org.orgId);
    const dept = await h
      .api()
      .post(`${API}/org/departments`)
      .set('Authorization', `Bearer ${org.ownerToken}`)
      .send({ name: 'Engineering' })
      .expect(201);
    const deptId = dept.body.data.id;
    const email = randomEmail('emp');
    const member = await h
      .api()
      .post(`${API}/org/members`)
      .set('Authorization', `Bearer ${org.ownerToken}`)
      .send({ email, role: 'employee', departmentId: deptId, firstName: 'Eng', lastName: 'Ineer' })
      .expect(201);
    const userId = member.body.data.userId;
    h.trackUser(userId);
    const token = await h.mintToken(email);
    return { org, deptId, userId, token };
  };

  // Remove the auto-seeded org-wide default so a test's own policy is the winner.
  const clearSeededDefault = async (orgId: string) => {
    await policies.delete({ organizationId: orgId, applicableTo: 'all' });
  };

  // Policies are created as drafts by default; these tests need them governing
  // attendance, so activate them (isActive: true) unless the body overrides it.
  const createPolicy = (org: CreatedOrg, body: any) =>
    h
      .api()
      .post(`${API}/policies`)
      .set('Authorization', `Bearer ${org.ownerToken}`)
      .send({ isActive: true, ...body });

  const clockIn = (token: string, body: any = {}) =>
    h.api().post(`${API}/attendance/check-in`).set('Authorization', `Bearer ${token}`).send(body);

  let ctx: Awaited<ReturnType<typeof setup>>;
  let res: request.Response;

  const givenOrg = (given: any) =>
    given(/^an organization with an employee in the "Engineering" department$/, async () => {
      ctx = await setup();
    });

  // ── status driven by policy ─────────────────────────────────────────────────

  test('a clock-in is judged against the org work-timing policy', ({ given, when, then }) => {
    givenOrg(given);
    given(/^the org work-timing policy starts at .* with a 15 minute grace$/, async () => {
      await clearSeededDefault(ctx.org.orgId);
      const tz = noonTz();
      const start = hhmmInTz(new Date(Date.now() - 40 * 60_000), tz); // 40 min ago
      await createPolicy(ctx.org, {
        policyName: 'Timing',
        category: 'working_hours',
        applicableTo: 'all',
        workTiming: { startTime: start, endTime: '23:59', timezone: tz, graceMinutes: 15 },
      }).expect(201);
    });
    when(/^the employee clocks in 40 minutes after the start time$/, async () => {
      res = await clockIn(ctx.token);
    });
    then(/^the record is marked late$/, () => {
      expect(res.status).toBe(201);
      expect(['late', 'half_day']).toContain(res.body.data.status);
      expect(res.body.data.isLateArrival).toBe(true);
    });
  });

  test('the policy — not a fixed default — decides what counts as late', ({ given, when, then }) => {
    givenOrg(given);
    given(/^the org work-timing policy starts at .* with a 15 minute grace$/, async () => {
      await clearSeededDefault(ctx.org.orgId);
      const tz = noonTz();
      const start = hhmmInTz(new Date(Date.now() + 120 * 60_000), tz); // starts in 2h
      await createPolicy(ctx.org, {
        policyName: 'Late Start',
        category: 'working_hours',
        applicableTo: 'all',
        workTiming: { startTime: start, endTime: '23:59', timezone: tz, graceMinutes: 15 },
      }).expect(201);
    });
    when(/^the employee clocks in at .* local time$/, async () => {
      res = await clockIn(ctx.token);
    });
    then(/^the record is marked present$/, () => {
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('present');
      expect(res.body.data.isLateArrival).toBe(false);
    });
  });

  test('a department policy overrides the org-wide default', ({ given, and, when, then }) => {
    givenOrg(given);
    given(/^the org-wide policy starts at .*$/, async () => {
      await clearSeededDefault(ctx.org.orgId);
      const tz = noonTz();
      const start = hhmmInTz(new Date(Date.now() - 40 * 60_000), tz); // would be LATE
      await createPolicy(ctx.org, {
        policyName: 'Org Default',
        category: 'working_hours',
        applicableTo: 'all',
        workTiming: { startTime: start, endTime: '23:59', timezone: tz, graceMinutes: 15 },
      }).expect(201);
    });
    and(/^an Engineering department policy starts at .*$/, async () => {
      const tz = noonTz();
      const start = hhmmInTz(new Date(Date.now() + 120 * 60_000), tz); // PRESENT
      await createPolicy(ctx.org, {
        policyName: 'Eng Timing',
        category: 'working_hours',
        applicableTo: 'department',
        applicableIds: [ctx.deptId],
        workTiming: { startTime: start, endTime: '23:59', timezone: tz, graceMinutes: 15 },
      }).expect(201);
    });
    when(/^the Engineering employee clocks in at .* local time$/, async () => {
      res = await clockIn(ctx.token);
    });
    then(/^the record is marked present$/, () => {
      // The department policy (present) must win over the org-wide default (late).
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('present');
    });
  });

  // ── office geo-fence governed by policy ─────────────────────────────────────
  // (WFH is now a request/approval flow — see wfh-request.e2e-spec.ts.)

  const OFFICE = { latitude: 12.9716, longitude: 77.5946 }; // Bengaluru
  const FAR = { latitude: 13.0827, longitude: 80.2707 }; // Chennai (~290 km)

  const officePolicy = (org: CreatedOrg) =>
    createPolicy(org, {
      policyName: 'Office',
      category: 'attendance',
      applicableTo: 'all',
      workTiming: { startTime: '00:00', endTime: '23:59', timezone: 'Asia/Kolkata' },
      workLocation: {
        mode: 'office',
        geoFenceRadiusKm: 2,
        offices: [{ name: 'HQ', ...OFFICE }],
      },
    });

  test('an office geo-fence blocks a clock-in outside the radius', ({ given, when, then }) => {
    givenOrg(given);
    given(/^an office policy with a geo-fence around the office applies to the employee$/, async () => {
      await clearSeededDefault(ctx.org.orgId);
      await officePolicy(ctx.org).expect(201);
    });
    when(/^the employee clocks in from outside the radius$/, async () => {
      res = await clockIn(ctx.token, { location: FAR });
    });
    then(/^the clock-in is rejected$/, () => {
      expect(res.status).toBe(400);
    });
  });

  test('an office geo-fence allows a clock-in inside the radius', ({ given, when, then }) => {
    givenOrg(given);
    given(/^an office policy with a geo-fence around the office applies to the employee$/, async () => {
      await clearSeededDefault(ctx.org.orgId);
      await officePolicy(ctx.org).expect(201);
    });
    when(/^the employee clocks in from inside the radius$/, async () => {
      res = await clockIn(ctx.token, { location: OFFICE });
    });
    then(/^the clock-in succeeds$/, () => {
      expect(res.status).toBe(201);
    });
  });

});
