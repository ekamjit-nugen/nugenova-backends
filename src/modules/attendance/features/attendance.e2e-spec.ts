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
