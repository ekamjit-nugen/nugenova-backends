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
import { dayAnchorUtc } from '../util/tz-day.util';

const feature = loadFeature('./attendance-night-shift.feature', { loadRelativePath: true });
const API = '/api/v1';
const TZ = process.env.ATTENDANCE_DEFAULT_TZ || 'Asia/Kolkata';
const HOUR = 3_600_000;

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

  const createPolicy = (org: CreatedOrg, body: any) =>
    h
      .api()
      .post(`${API}/policies`)
      .set('Authorization', `Bearer ${org.ownerToken}`)
      .send({ isActive: true, ...body });

  /** An org whose only work-timing policy is the one this test installs. */
  const setup = async (startTime: string, endTime: string, isNightShift: boolean) => {
    const org = await h.createOrg();
    orgIds.add(org.orgId);
    // Drop the auto-seeded org default so the shift under test is the winner.
    await policies.delete({ organizationId: org.orgId, applicableTo: 'all' });
    await createPolicy(org, {
      policyName: isNightShift ? 'Evening Shift' : 'Day Shift',
      category: 'attendance',
      applicableTo: 'all',
      workTiming: {
        startTime,
        endTime,
        timezone: TZ,
        graceMinutes: 15,
        minWorkingHours: 8,
        breakMinutes: 60,
        isNightShift,
      },
    }).expect(201);

    const email = randomEmail('night');
    const member = await h
      .api()
      .post(`${API}/org/members`)
      .set('Authorization', `Bearer ${org.ownerToken}`)
      .send({ email, role: 'employee', firstName: 'Ny', lastName: 'Shift' })
      .expect(201);
    const userId = member.body.data.userId;
    h.trackUser(userId);
    return { org, userId, token: await h.mintToken(email) };
  };

  /**
   * A session opened `hoursAgo` ago and never closed, filed under YESTERDAY's
   * org-day — the shape a night shift always has once the clock passes midnight.
   */
  const openSessionYesterday = async (orgId: string, userId: string, hoursAgo: number) => {
    const openedAt = new Date(Date.now() - hoursAgo * HOUR);
    return attendance.save(
      attendance.create({
        organizationId: orgId,
        employeeId: userId,
        date: dayAnchorUtc(new Date(), TZ, -1),
        checkInTime: openedAt,
        entryType: 'system',
        status: 'present',
        isNightShift: true,
        workSegments: [{ checkInTime: openedAt.toISOString(), checkOutTime: null }],
      }),
    );
  };

  let ctx: Awaited<ReturnType<typeof setup>>;
  let seeded: AttendanceEntity;
  let res: request.Response;

  const givenNightOrg = (given: any) =>
    given(/^an organization with an employee on a 16:30 to 01:30 night shift$/, async () => {
      ctx = await setup('16:30', '01:30', true);
    });
  const givenOpenSince = (step: any) =>
    step(/^the employee has been clocked in since last night$/, async () => {
      seeded = await openSessionYesterday(ctx.org.orgId, ctx.userId, 3);
    });
  const clockOut = (when: any) =>
    when(/^the employee clocks out$/, async () => {
      res = await h
        .api()
        .post(`${API}/attendance/check-out`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({});
    });
  const refused = (then: any) =>
    then(/^the clock-out is refused$/, () => {
      expect(res.status).toBe(404);
    });

  test("clocking out after midnight closes last night's session", ({ given, when, then, and }) => {
    givenNightOrg(given);
    givenOpenSince(given);
    clockOut(when);

    then("last night's record is closed", async () => {
      expect(res.status).toBe(200);
      const row = await attendance.findOne({ where: { id: seeded.id } });
      expect(row?.checkOutTime).toBeTruthy();
      expect(row?.workSegments?.[0]?.checkOutTime).toBeTruthy();
      // The hours land on the day the shift belongs to, not on today.
      expect(Number(row?.totalWorkingHours)).toBeGreaterThan(2.5);
    });

    and('no second record was created for today', async () => {
      const rows = await attendance.find({
        where: { organizationId: ctx.org.orgId, employeeId: ctx.userId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(seeded.id);
    });
  });

  test('the phantom day is refused rather than created', ({ given, when, then }) => {
    givenNightOrg(given);
    givenOpenSince(given);

    when(/^the employee clocks in again$/, async () => {
      res = await h
        .api()
        .post(`${API}/attendance/check-in`)
        .set('Authorization', `Bearer ${ctx.token}`)
        .send({});
    });

    then(/^they are told they are still clocked in from their last shift$/, async () => {
      expect(res.status).toBe(409);
      expect(String(res.body.message)).toMatch(/still clocked in/i);
      // The phantom record is the actual damage — make sure none appeared.
      const rows = await attendance.find({
        where: { organizationId: ctx.org.orgId, employeeId: ctx.userId },
      });
      expect(rows).toHaveLength(1);
    });
  });

  test('mid-shift the employee is shown as clocked in, not clocked out', ({ given, when, then }) => {
    givenNightOrg(given);
    givenOpenSince(given);

    when(/^the employee checks today's status$/, async () => {
      res = await h
        .api()
        .get(`${API}/attendance/today`)
        .set('Authorization', `Bearer ${ctx.token}`);
    });

    then(/^they are shown as clocked in on a session carried over from yesterday$/, () => {
      expect(res.status).toBe(200);
      expect(res.body.data.checkedIn).toBe(true);
      expect(res.body.data.hasOpenSession).toBe(true);
      expect(res.body.data.carriedOver).toBe(true);
    });
  });

  test('a session left open for days is not claimable by a clock-out', ({ given, when, then }) => {
    givenNightOrg(given);

    given(/^the employee has a session left open since well before yesterday$/, async () => {
      // Past the staleness threshold the reconcile cron owns this session.
      seeded = await openSessionYesterday(ctx.org.orgId, ctx.userId, 30);
    });

    clockOut(when);
    refused(then);
  });

  test("a day shift still treats yesterday's open session as a missed checkout", ({
    given,
    and,
    when,
    then,
  }) => {
    givenNightOrg(given);

    given(/^the employee is moved to a 09:00 to 18:00 day shift$/, async () => {
      ctx = await setup('09:00', '18:00', false);
    });
    givenOpenSince(and);
    clockOut(when);
    refused(then);
  });
});
