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

const feature = loadFeature('./attendance-department-scope.feature', {
  loadRelativePath: true,
});

const API = '/api/v1';

/**
 * "A manager leads their own team." A custom role bound to a department carries a
 * `departmentScopeId` in its holder's JWT; the attendance surface narrows every
 * org-wide read to that department and refuses writes on employees outside it.
 * Built once (Background) and shared read-only across scenarios; the approval
 * scenarios add their own past-dated pending rows so nothing collides.
 */
defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let attendance: Repository<AttendanceEntity>;
  const orgIds = new Set<string>();

  // Shared scenario state (built in beforeAll).
  let org: CreatedOrg;
  let engId: string;
  let salesId: string;
  let mgrRoleId: string;
  let devRoleId: string;
  let aliceToken: string;
  let bobToken: string;
  let bobUserId: string;
  let daveToken: string;
  let daveUserId: string;

  const createDept = (token: string, name: string) =>
    h
      .api()
      .post(`${API}/org/departments`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name });

  const createRole = (
    token: string,
    body: {
      name: string;
      displayName: string;
      departmentId?: string;
      permissions: Array<{ resource: string; actions: string[] }>;
    },
  ) =>
    h
      .api()
      .post(`${API}/org/roles`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const addMember = (token: string, body: Record<string, unknown>) =>
    h
      .api()
      .post(`${API}/org/members`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const clockIn = (token: string) =>
    h
      .api()
      .post(`${API}/attendance/check-in`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

  const listAttendance = (token: string) =>
    h.api().get(`${API}/attendance`).set('Authorization', `Bearer ${token}`);

  const fileManualEntry = (token: string, day: string) =>
    h
      .api()
      .post(`${API}/attendance/manual-entry`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        date: day,
        checkInTime: `${day}T09:00:00.000Z`,
        checkOutTime: `${day}T17:00:00.000Z`,
        reason: 'Forgot to clock in',
      });

  beforeAll(async () => {
    h = await bootOrgTestApp();
    attendance = h.app.get<Repository<AttendanceEntity>>(
      getRepositoryToken(AttendanceEntity),
    );

    // Org + two departments.
    org = await h.createOrg();
    orgIds.add(org.orgId);
    engId = (await createDept(org.ownerToken, 'Engineering').expect(201)).body.data
      .id;
    salesId = (await createDept(org.ownerToken, 'Sales').expect(201)).body.data.id;

    // Two department-scoped roles inside Engineering: a manager who can view/edit
    // attendance, and a developer with NO attendance permission (self-service only).
    mgrRoleId = (
      await createRole(org.ownerToken, {
        name: 'eng_manager',
        displayName: 'Engineering Manager',
        departmentId: engId,
        permissions: [{ resource: 'attendance', actions: ['view', 'edit'] }],
      }).expect(201)
    ).body.data.id;
    devRoleId = (
      await createRole(org.ownerToken, {
        name: 'eng_developer',
        displayName: 'Engineering Developer',
        departmentId: engId,
        permissions: [{ resource: 'tasks', actions: ['view'] }],
      }).expect(201)
    ).body.data.id;

    // Alice leads Engineering; Bob develops in Engineering; Dave sits in Sales.
    const aliceEmail = randomEmail('alice');
    const alice = await addMember(org.ownerToken, {
      email: aliceEmail,
      roleId: mgrRoleId,
      departmentId: engId,
      firstName: 'Alice',
      lastName: 'Lead',
    }).expect(201);
    h.trackUser(alice.body.data.userId);
    aliceToken = await h.mintToken(aliceEmail);

    const bobEmail = randomEmail('bob');
    const bob = await addMember(org.ownerToken, {
      email: bobEmail,
      roleId: devRoleId,
      departmentId: engId,
      firstName: 'Bob',
      lastName: 'Dev',
    }).expect(201);
    bobUserId = bob.body.data.userId;
    h.trackUser(bobUserId);
    bobToken = await h.mintToken(bobEmail);

    const daveEmail = randomEmail('dave');
    const dave = await addMember(org.ownerToken, {
      email: daveEmail,
      role: 'employee',
      departmentId: salesId,
      firstName: 'Dave',
      lastName: 'Sales',
    }).expect(201);
    daveUserId = dave.body.data.userId;
    h.trackUser(daveUserId);
    daveToken = await h.mintToken(daveEmail);

    // Give Bob and Dave a row today (self-service clock-in) so the roster has data.
    await clockIn(bobToken).expect(201);
    await clockIn(daveToken).expect(201);
  });

  afterAll(async () => {
    const ids = [...orgIds];
    if (ids.length) {
      await attendance.delete({ organizationId: In(ids) }).catch(() => undefined);
    }
    await h.cleanup();
  });

  // The Background is built once in beforeAll; these steps document intent and
  // assert the shared fixtures exist. They deliberately do no rebuilding.
  const bindBackground = (given: any, and: any) => {
    given(
      'an organization with an "Engineering" and a "Sales" department',
      () => {
        expect(engId).toBeTruthy();
        expect(salesId).toBeTruthy();
      },
    );
    and(
      'an "Engineering Manager" role scoped to Engineering granting attendance view and edit',
      () => {
        expect(mgrRoleId).toBeTruthy();
      },
    );
    and(
      'an "Engineering Developer" role scoped to Engineering with no attendance permission',
      () => {
        expect(devRoleId).toBeTruthy();
      },
    );
    and('Alice is the Engineering manager', () => {
      expect(aliceToken).toBeTruthy();
    });
    and('Bob is an Engineering developer with attendance on record', () => {
      expect(bobUserId).toBeTruthy();
    });
    and('Dave is a Sales developer with attendance on record', () => {
      expect(daveUserId).toBeTruthy();
    });
  };

  test('A department-scoped manager sees only their own department', ({
    given,
    and,
    when,
    then,
  }) => {
    let res: request.Response;
    bindBackground(given, and);

    when('Alice lists attendance', async () => {
      res = await listAttendance(aliceToken);
    });
    then('she sees Bob from Engineering', () => {
      expect(res.status).toBe(200);
      const ids = (res.body.data as any[]).map((r) => r.employeeId);
      expect(ids).toContain(bobUserId);
    });
    and('she does not see Dave from Sales', () => {
      const ids = (res.body.data as any[]).map((r) => r.employeeId);
      expect(ids).not.toContain(daveUserId);
    });
  });

  test('The owner sees every department', ({ given, and, when, then }) => {
    let res: request.Response;
    bindBackground(given, and);

    when('the owner lists attendance', async () => {
      res = await listAttendance(org.ownerToken);
    });
    then('the owner sees both Bob and Dave', () => {
      expect(res.status).toBe(200);
      const ids = (res.body.data as any[]).map((r) => r.employeeId);
      expect(ids).toContain(bobUserId);
      expect(ids).toContain(daveUserId);
    });
  });

  test('A developer cannot open the team roster', ({
    given,
    and,
    when,
    then,
  }) => {
    let res: request.Response;
    bindBackground(given, and);

    when('Bob lists attendance', async () => {
      res = await listAttendance(bobToken);
    });
    then('he is denied as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  test('A developer still clocks themselves in', ({
    given,
    and,
    when,
    then,
  }) => {
    let res: request.Response;
    bindBackground(given, and);

    when('a new Engineering developer clocks in', async () => {
      const email = randomEmail('erin');
      const erin = await addMember(org.ownerToken, {
        email,
        roleId: devRoleId,
        departmentId: engId,
        firstName: 'Erin',
        lastName: 'Dev',
      }).expect(201);
      h.trackUser(erin.body.data.userId);
      const token = await h.mintToken(email);
      res = await clockIn(token);
    });
    then('the clock-in succeeds', () => {
      expect(res.status).toBe(201);
      expect(res.body.data.workSegments).toHaveLength(1);
    });
  });

  test('A manager cannot approve attendance outside their department', ({
    given,
    and,
    when,
    then,
  }) => {
    let entryId: string;
    let res: request.Response;
    bindBackground(given, and);

    given('Dave has a pending manual attendance entry', async () => {
      const entry = await fileManualEntry(daveToken, '2026-07-08').expect(201);
      entryId = entry.body.data.id;
    });
    when('Alice approves that entry', async () => {
      res = await h
        .api()
        .put(`${API}/attendance/${entryId}/approve`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ approved: true });
    });
    then('she is denied as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  test('A manager approves attendance inside their department', ({
    given,
    and,
    when,
    then,
  }) => {
    let entryId: string;
    let res: request.Response;
    bindBackground(given, and);

    given('Bob has a pending manual attendance entry', async () => {
      const entry = await fileManualEntry(bobToken, '2026-07-09').expect(201);
      entryId = entry.body.data.id;
    });
    when('Alice approves that entry', async () => {
      res = await h
        .api()
        .put(`${API}/attendance/${entryId}/approve`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ approved: true });
    });
    then('the approval succeeds', () => {
      expect(res.status).toBe(200);
      expect(res.body.data.approvalStatus).toBe('approved');
    });
  });
});
