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
import { HolidayEntity } from '../entities/holiday.entity';
import { dayAnchorUtc, DEFAULT_TZ } from '../util/tz-day.util';

const feature = loadFeature('./attendance.feature', { loadRelativePath: true });

const API = '/api/v1';

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let attendance: Repository<AttendanceEntity>;
  let holidays: Repository<HolidayEntity>;
  const orgIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    attendance = h.app.get<Repository<AttendanceEntity>>(
      getRepositoryToken(AttendanceEntity),
    );
    holidays = h.app.get<Repository<HolidayEntity>>(getRepositoryToken(HolidayEntity));
  });

  afterAll(async () => {
    const ids = [...orgIds];
    if (ids.length) {
      await attendance.delete({ organizationId: In(ids) }).catch(() => undefined);
      await holidays.delete({ organizationId: In(ids) }).catch(() => undefined);
    }
    await h.cleanup();
  });

  /** Create an org (tracked for cleanup) + an employee-tier member logged in. */
  const orgWithEmployee = async (): Promise<{
    org: CreatedOrg;
    employee: { email: string; userId: string; token: string };
  }> => {
    const org = await h.createOrg();
    orgIds.add(org.orgId);
    const employee = await h.createEmployeeMember(org);
    return { org, employee };
  };

  const clockIn = (token: string) =>
    h.api().post(`${API}/attendance/check-in`).set('Authorization', `Bearer ${token}`).send({});

  const clockOut = (token: string) =>
    h.api().post(`${API}/attendance/check-out`).set('Authorization', `Bearer ${token}`).send({});

  // ── clock loop ──────────────────────────────────────────────────────────────

  test('an employee clocks in and then clocks out', ({ given, when, then }) => {
    let employee: { token: string };
    let res: request.Response;

    given('an organization with an employee', async () => {
      ({ employee } = await orgWithEmployee());
    });
    when('the employee clocks in', async () => {
      res = await clockIn(employee.token);
    });
    then('the clock-in succeeds with an open session', () => {
      expect(res.status).toBe(201);
      expect(res.body.data.workSegments).toHaveLength(1);
      expect(res.body.data.workSegments[0].checkOutTime).toBeFalsy();
    });
    when('the employee clocks out', async () => {
      res = await clockOut(employee.token);
    });
    then('the clock-out succeeds and worked hours are recorded', () => {
      expect(res.status).toBe(200);
      expect(res.body.data.checkOutTime).toBeTruthy();
      expect(typeof res.body.data.totalWorkingHours).toBe('number');
    });
  });

  test('clocking in twice without clocking out is rejected', ({ given, and, when, then }) => {
    let employee: { token: string };
    let res: request.Response;

    given('an organization with an employee', async () => {
      ({ employee } = await orgWithEmployee());
    });
    and('the employee has clocked in', async () => {
      await clockIn(employee.token).expect(201);
    });
    when('the employee clocks in again', async () => {
      res = await clockIn(employee.token);
    });
    then('the request is rejected as a conflict', () => {
      expect(res.status).toBe(409);
    });
  });

  test('an owner cannot clock their own time', ({ given, when, then }) => {
    let org: CreatedOrg;
    let res: request.Response;

    given('an organization with an employee', async () => {
      ({ org } = await orgWithEmployee());
    });
    when('the owner tries to clock in', async () => {
      res = await clockIn(org.ownerToken);
    });
    then('the request is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  // ── stats scope ─────────────────────────────────────────────────────────────

  test("an employee's stats are scoped to themselves", ({ given, when, then }) => {
    let employee: { token: string };
    let res: request.Response;

    given('an organization with an employee', async () => {
      ({ employee } = await orgWithEmployee());
    });
    when('the employee requests stats', async () => {
      res = await h
        .api()
        .get(`${API}/attendance/stats`)
        .set('Authorization', `Bearer ${employee.token}`);
    });
    then('the stats scope is self', () => {
      expect(res.status).toBe(200);
      expect(res.body.data.scope).toBe('self');
    });
  });

  test('a privileged member sees org-wide stats', ({ given, when, then }) => {
    let org: CreatedOrg;
    let res: request.Response;

    given('an organization with an employee', async () => {
      ({ org } = await orgWithEmployee());
    });
    when('the owner requests stats', async () => {
      res = await h
        .api()
        .get(`${API}/attendance/stats`)
        .set('Authorization', `Bearer ${org.ownerToken}`);
    });
    then('the stats scope is org', () => {
      expect(res.status).toBe(200);
      expect(res.body.data.scope).toBe('org');
    });
  });

  // ── tenant isolation ────────────────────────────────────────────────────────

  test("one organization cannot see another organization's attendance", ({
    given,
    and,
    when,
    then,
  }) => {
    let orgA: CreatedOrg;
    let empA: { userId: string; token: string };
    let orgB: CreatedOrg;
    let res: request.Response;

    given('two organizations each with an employee', async () => {
      const a = await orgWithEmployee();
      orgA = a.org;
      empA = a.employee;
      const b = await orgWithEmployee();
      orgB = b.org;
    });
    and("the first organization's employee has clocked in", async () => {
      await clockIn(empA.token).expect(201);
    });
    when("the second organization's owner lists attendance", async () => {
      res = await h
        .api()
        .get(`${API}/attendance`)
        .set('Authorization', `Bearer ${orgB.ownerToken}`);
    });
    then("the first organization's record is not visible", () => {
      expect(res.status).toBe(200);
      const ids = (res.body.data as any[]).map((r) => r.employeeId);
      expect(ids).not.toContain(empA.userId);
    });
  });

  test("the platform super admin cannot read an organization's attendance", ({
    given,
    when,
    then,
  }) => {
    let res: request.Response;

    given('an organization with an employee', async () => {
      await orgWithEmployee();
    });
    when("the platform super admin lists that organization's attendance", async () => {
      // A super admin is NOT an org member; their JWT carries no organizationId,
      // so /attendance/* must be closed to them (cross-tenant isolation gate).
      const sa = await h.createSuperAdmin();
      res = await h
        .api()
        .get(`${API}/attendance`)
        .set('Authorization', `Bearer ${sa.token}`);
    });
    then('the request is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  // ── RBAC matrix ─────────────────────────────────────────────────────────────

  test('a permission-scoped member with attendance:view can list attendance', ({
    given,
    when,
    then,
  }) => {
    let viewerToken: string;
    let res: request.Response;

    given('an organization with an attendance-viewer member', async () => {
      const org = await h.createOrg();
      orgIds.add(org.orgId);
      const role = await h
        .api()
        .post(`${API}/org/roles`)
        .set('Authorization', `Bearer ${org.ownerToken}`)
        .send({
          name: 'att_viewer',
          displayName: 'Attendance Viewer',
          permissions: [{ resource: 'attendance', actions: ['view'] }],
        })
        .expect(201);
      const email = randomEmail('attview');
      const member = await h
        .api()
        .post(`${API}/org/members`)
        .set('Authorization', `Bearer ${org.ownerToken}`)
        .send({ email, roleId: role.body.data.id, firstName: 'Att', lastName: 'Viewer' })
        .expect(201);
      h.trackUser(member.body.data.userId);
      viewerToken = await h.mintToken(email);
    });
    when('the attendance-viewer lists attendance', async () => {
      res = await h
        .api()
        .get(`${API}/attendance`)
        .set('Authorization', `Bearer ${viewerToken}`);
    });
    then('the request succeeds', () => {
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  test('a plain employee cannot list org-wide attendance', ({ given, when, then }) => {
    let employee: { token: string };
    let res: request.Response;

    given('an organization with an employee', async () => {
      ({ employee } = await orgWithEmployee());
    });
    when('the employee lists attendance', async () => {
      res = await h
        .api()
        .get(`${API}/attendance`)
        .set('Authorization', `Bearer ${employee.token}`);
    });
    then('the request is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  test('an employee cannot file a manual entry for someone else', ({
    given,
    when,
    then,
  }) => {
    let employee: { token: string };
    let res: request.Response;

    given('an organization with an employee', async () => {
      ({ employee } = await orgWithEmployee());
    });
    when('the employee submits a manual entry for another user id', async () => {
      res = await h
        .api()
        .post(`${API}/attendance/manual-entry`)
        .set('Authorization', `Bearer ${employee.token}`)
        .send({
          employeeId: '000000000000000000000099',
          date: '2026-08-20',
          checkInTime: '2026-08-20T09:00:00.000Z',
          checkOutTime: '2026-08-20T17:00:00.000Z',
          reason: 'injection attempt',
        });
    });
    then('the request is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  test('the activity feed includes manual entries and can be filtered by person and date', ({
    given,
    when,
    and,
    then,
  }) => {
    let org: CreatedOrg;
    let employee: { userId: string; token: string };
    const DATE = '2026-08-20';

    given('an organization with an employee', async () => {
      ({ org, employee } = await orgWithEmployee());
    });
    when('the employee files a manual entry for a past day', async () => {
      await h
        .api()
        .post(`${API}/attendance/manual-entry`)
        .set('Authorization', `Bearer ${employee.token}`)
        .send({ date: DATE, checkInTime: `${DATE}T03:30:00.000Z`, checkOutTime: `${DATE}T12:30:00.000Z`, reason: 'Forgot to clock in' })
        .expect(201);
    });
    let feed: any[];
    and('the owner opens the activity feed for that date range', async () => {
      const res = await h
        .api()
        .get(`${API}/attendance/activity?view=timeline&startDate=2026-08-01&endDate=2026-08-31`)
        .set('Authorization', `Bearer ${org.ownerToken}`)
        .expect(200);
      feed = res.body.data;
    });
    then('the manual entry appears in the feed with its approval state', () => {
      // A manual entry has no workSegments — it must still surface via the fallback.
      const evt = feed.find((e) => e.employeeId === employee.userId && e.type === 'clock_in');
      expect(evt).toBeTruthy();
      expect(evt.entryType).toBe('manual');
      expect(evt.approvalStatus).toBe('pending');
    });
    and('filtering the feed by a different person returns nothing', async () => {
      const res = await h
        .api()
        .get(`${API}/attendance/activity?view=timeline&startDate=2026-08-01&endDate=2026-08-31&employeeId=000000000000000000000099`)
        .set('Authorization', `Bearer ${org.ownerToken}`)
        .expect(200);
      expect(res.body.data.length).toBe(0);
    });
  });

  test('the daily activity view returns one consolidated row per day', ({ given, when, and, then }) => {
    let org: CreatedOrg;
    let employee: { userId: string; token: string };
    const DATE = '2026-08-21';

    given('an organization with an employee', async () => {
      ({ org, employee } = await orgWithEmployee());
    });
    when('the employee files a manual entry for a past day', async () => {
      await h
        .api()
        .post(`${API}/attendance/manual-entry`)
        .set('Authorization', `Bearer ${employee.token}`)
        .send({ date: DATE, checkInTime: `${DATE}T03:30:00.000Z`, checkOutTime: `${DATE}T12:30:00.000Z`, reason: 'Forgot to clock in' })
        .expect(201);
    });
    let rows: any[];
    and('the owner opens the daily activity view for that date range', async () => {
      const res = await h
        .api()
        .get(`${API}/attendance/activity?view=daily&startDate=2026-08-01&endDate=2026-08-31`)
        .set('Authorization', `Bearer ${org.ownerToken}`)
        .expect(200);
      rows = res.body.data;
    });
    then('there is a single row for that day with its clock-in and hours', () => {
      const mine = rows.filter((r) => r.employeeId === employee.userId);
      expect(mine.length).toBe(1); // one consolidated row, not two events
      expect(mine[0].firstIn).toBeTruthy();
      expect(mine[0].lastOut).toBeTruthy();
      expect(mine[0].missedCheckout).toBe(false);
      expect(Number(mine[0].effectiveHours)).toBeGreaterThan(0);
    });
  });

  test('a clock-in is rejected when the day already has attendance covering that time', ({
    given,
    and,
    when,
    then,
  }) => {
    let org: CreatedOrg;
    let employee: { userId: string; token: string };
    let res: request.Response;

    given('an organization with an employee', async () => {
      ({ org, employee } = await orgWithEmployee());
    });
    and('the employee already has a session recorded until later today', async () => {
      const now = Date.now();
      const anchor = dayAnchorUtc(new Date(now), DEFAULT_TZ);
      const inAt = new Date(now - 60 * 60 * 1000); // 1h ago
      const outAt = new Date(now + 3 * 60 * 60 * 1000); // 3h from now (future)
      await attendance.save(
        attendance.create({
          organizationId: org.orgId,
          employeeId: employee.userId,
          date: anchor,
          checkInTime: inAt,
          checkOutTime: outAt,
          status: 'present',
          entryType: 'system',
          workSegments: [{ checkInTime: inAt.toISOString(), checkOutTime: outAt.toISOString() }] as any,
        }),
      );
    });
    when('the employee tries to clock in now', async () => {
      res = await h
        .api()
        .post(`${API}/attendance/check-in`)
        .set('Authorization', `Bearer ${employee.token}`)
        .send({});
    });
    then('the clock-in is rejected as a conflict', () => {
      expect(res.status).toBe(409);
      expect(String(res.body.message)).toMatch(/already have attendance recorded/i);
    });
  });

  test('a manual entry and a clock-in on the same day fold into one daily card', ({
    given,
    and,
    when,
    then,
  }) => {
    let org: CreatedOrg;
    let employee: { userId: string; token: string };
    const DATE = '2026-08-19';
    let rows: any[];

    given('an organization with an employee', async () => {
      ({ org, employee } = await orgWithEmployee());
    });
    and('the employee has both a manual entry and a separate record on the same past day', async () => {
      await h
        .api()
        .post(`${API}/attendance/manual-entry`)
        .set('Authorization', `Bearer ${employee.token}`)
        .send({ date: DATE, checkInTime: `${DATE}T03:30:00.000Z`, checkOutTime: `${DATE}T07:30:00.000Z`, reason: 'Morning' })
        .expect(201);
      // A second (system) record for the same day — the partial unique index only
      // covers system rows, so a manual + system pair can co-exist.
      await attendance.save(
        attendance.create({
          organizationId: org.orgId,
          employeeId: employee.userId,
          date: new Date(`${DATE}T00:00:00.000Z`),
          checkInTime: new Date(`${DATE}T09:00:00.000Z`),
          checkOutTime: new Date(`${DATE}T12:30:00.000Z`),
          status: 'present',
          entryType: 'system',
          workSegments: [{ checkInTime: `${DATE}T09:00:00.000Z`, checkOutTime: `${DATE}T12:30:00.000Z` }] as any,
        }),
      );
    });
    when('the owner opens the daily activity view for that date range', async () => {
      const res = await h
        .api()
        .get(`${API}/attendance/activity?view=daily&startDate=2026-08-01&endDate=2026-08-31`)
        .set('Authorization', `Bearer ${org.ownerToken}`)
        .expect(200);
      rows = res.body.data.filter((r: any) => r.employeeId === employee.userId);
    });
    then('that day shows as a single consolidated row', () => {
      expect(rows.length).toBe(1); // merged, not two cards
      expect(rows[0].sessions.length).toBe(2); // both sessions kept for the bar
    });
  });

  test('the owner sees the attendance setup status with the holiday gap flagged', ({ given, when, then }) => {
    let org: CreatedOrg;
    let body: any;

    given('an organization with an employee', async () => {
      ({ org } = await orgWithEmployee());
    });
    when('the owner reads the attendance setup status', async () => {
      const res = await h.api().get(`${API}/attendance/setup-status`).set('Authorization', `Bearer ${org.ownerToken}`).expect(200);
      body = res.body.data;
    });
    then('it reports the work schedule and flags that no holidays are configured', () => {
      const byKey = Object.fromEntries((body.items as any[]).map((i) => [i.key, i]));
      expect(byKey.schedule.status).toBe('ok');
      expect(byKey.schedule.value).toMatch(/\d{2}:\d{2}/);
      expect(byKey.holidays.status).toBe('attention');
      expect(body.attentionCount).toBeGreaterThanOrEqual(1);
    });
  });

  test('a plain employee cannot read the attendance setup status', ({ given, when, then }) => {
    let employee: { token: string };
    let status = 0;

    given('an organization with an employee', async () => {
      ({ employee } = await orgWithEmployee());
    });
    when('the employee requests the attendance setup status', async () => {
      const res = await h.api().get(`${API}/attendance/setup-status`).set('Authorization', `Bearer ${employee.token}`);
      status = res.status;
    });
    then('the request is forbidden', () => {
      expect(status).toBe(403);
    });
  });

  test('the daily roster lists every active member, not only those with a record', ({ given, when, then, and }) => {
    let org: CreatedOrg;
    let employee: { userId: string; token: string };
    let rows: any[];

    given('an organization with an employee', async () => {
      ({ org, employee } = await orgWithEmployee());
    });
    when("the owner reads today's roster", async () => {
      const res = await h.api().get(`${API}/attendance/roster`).set('Authorization', `Bearer ${org.ownerToken}`).expect(200);
      rows = res.body.data.rows;
    });
    then('both the owner and the employee appear on it', () => {
      // The record list would show neither (no attendance yet); the roster shows all.
      expect(rows.some((r) => r.userId === employee.userId)).toBe(true);
      expect(rows.length).toBeGreaterThanOrEqual(2);
    });
    and('the employee shows as not clocked in while the owner is not tracked', () => {
      const emp = rows.find((r) => r.userId === employee.userId);
      const owner = rows.find((r) => r.role === 'owner');
      expect(emp.status).toBe('not_clocked_in');
      expect(owner?.status).toBe('not_tracked');
    });
  });

  // ── holidays ────────────────────────────────────────────────────────────────

  test('holidays are readable by all members but only writable by admins', ({
    given,
    when,
    then,
    and,
    but,
  }) => {
    let org: CreatedOrg;
    let employee: { token: string };
    let res: request.Response;

    given('an organization with an employee', async () => {
      ({ org, employee } = await orgWithEmployee());
    });
    when('the owner adds a holiday', async () => {
      res = await h
        .api()
        .post(`${API}/holidays`)
        .set('Authorization', `Bearer ${org.ownerToken}`)
        .send({ date: '2026-01-26', name: 'Republic Day', type: 'national' });
    });
    then('the holiday is created', () => {
      expect(res.status).toBe(201);
      expect(res.body.data.name).toBe('Republic Day');
    });
    and('the employee can read the holiday', async () => {
      const list = await h
        .api()
        .get(`${API}/holidays`)
        .set('Authorization', `Bearer ${employee.token}`)
        .expect(200);
      expect((list.body.data as any[]).some((hh) => hh.name === 'Republic Day')).toBe(true);
    });
    but('the employee cannot add a holiday', async () => {
      await h
        .api()
        .post(`${API}/holidays`)
        .set('Authorization', `Bearer ${employee.token}`)
        .send({ date: '2026-08-15', name: 'Independence Day' })
        .expect(403);
    });
  });
});
