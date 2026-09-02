import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { bootOrgTestApp, OrgTestHarness, CreatedOrg } from '../../organization/features/support/org-harness';
import { TimesheetEntity } from '../entities/timesheet.entity';

const feature = loadFeature('./timesheet.feature', { loadRelativePath: true });
const API = '/api/v1';
const REF = '2026-09-15'; // a Tuesday → week Mon 14th … Sun 20th

interface Member { email: string; userId: string; token: string }

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let sheets: Repository<TimesheetEntity>;
  const orgIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    sheets = h.app.get(getRepositoryToken(TimesheetEntity));
  });
  afterAll(async () => {
    const ids = [...orgIds];
    if (ids.length) await sheets.delete({ organizationId: In(ids) }).catch(() => undefined);
    await h.cleanup();
  });

  const setup = async (enabled: boolean): Promise<{ o: CreatedOrg; member: Member }> => {
    const o = await h.createOrg();
    orgIds.add(o.orgId);
    const member = await h.createEmployeeMember(o);
    await h
      .api()
      .put(`${API}/policies/timesheet-config`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
      .send({ enabled, cadence: 'weekly' })
      .expect(200);
    return { o, member };
  };

  const submit = (m: Member) =>
    h
      .api()
      .post(`${API}/timesheets/me/submit?ref=${REF}`)
      .set('Authorization', `Bearer ${m.token}`)
      .send({ entries: [{ date: '2026-09-15', hours: 8, note: 'Worked' }] });

  test('an employee submits a weekly timesheet and the owner approves it', ({ given, when, and, then }) => {
    let o: CreatedOrg;
    let member: Member;
    let sheetId: string;

    given('an organization with weekly timesheets enabled and an employee member', async () => {
      ({ o, member } = await setup(true));
    });
    when('the employee submits their timesheet for the week', async () => {
      const res = await submit(member).expect(200);
      expect(res.body.data.status).toBe('submitted');
      expect(res.body.data.totalHours).toBe(8);
      expect(res.body.data.cadence).toBe('weekly');
    });
    and('the owner approves the timesheet', async () => {
      const queue = await h.api().get(`${API}/timesheets?status=submitted`).set('Authorization', `Bearer ${o.ownerToken}`).expect(200);
      sheetId = queue.body.data[0].id;
      expect(sheetId).toBeTruthy();
      await h
        .api()
        .post(`${API}/timesheets/${sheetId}/review`)
        .set('Authorization', `Bearer ${o.ownerToken}`)
        .send({ action: 'approve' })
        .expect(200);
    });
    then("the employee's timesheet is approved and locked", async () => {
      const res = await h.api().get(`${API}/timesheets/me?ref=${REF}`).set('Authorization', `Bearer ${member.token}`).expect(200);
      expect(res.body.data.timesheet.status).toBe('approved');
      expect(res.body.data.timesheet.editable).toBe(false);
    });
  });

  test('a plain employee cannot open the timesheet review queue', ({ given, when, then }) => {
    let member: Member;
    let status = 0;
    given('an organization with weekly timesheets enabled and an employee member', async () => {
      ({ member } = await setup(true));
    });
    when('the employee requests the review queue', async () => {
      const res = await h.api().get(`${API}/timesheets`).set('Authorization', `Bearer ${member.token}`);
      status = res.status;
    });
    then('the request is forbidden', () => {
      expect(status).toBe(403);
    });
  });

  test('the owner filters team timesheets by month and employee', ({ given, when, then, and }) => {
    let o: CreatedOrg;
    let member: Member;

    given('an organization with weekly timesheets enabled and an employee member', async () => {
      ({ o, member } = await setup(true));
    });
    when('the employee submits their timesheet for the week', async () => {
      await submit(member).expect(200);
    });
    then('filtering the review by that month returns the timesheet', async () => {
      const res = await h.api().get(`${API}/timesheets?year=2026&month=9`).set('Authorization', `Bearer ${o.ownerToken}`).expect(200);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].employee.email).toBe(member.email);
    });
    and('filtering by a different month returns nothing', async () => {
      const res = await h.api().get(`${API}/timesheets?year=2026&month=3`).set('Authorization', `Bearer ${o.ownerToken}`).expect(200);
      expect(res.body.data.length).toBe(0);
    });
    and('filtering by that employee returns the timesheet', async () => {
      const res = await h.api().get(`${API}/timesheets?userId=${member.userId}`).set('Authorization', `Bearer ${o.ownerToken}`).expect(200);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data.every((t: any) => t.userId === member.userId)).toBe(true);
    });
  });

  test("the owner opens a timesheet's full day-by-day detail", ({ given, when, then }) => {
    let o: CreatedOrg;
    let member: Member;

    given('an organization with weekly timesheets enabled and an employee member', async () => {
      ({ o, member } = await setup(true));
    });
    when('the employee submits their timesheet for the week', async () => {
      await submit(member).expect(200);
    });
    then('the owner can open the timesheet detail and see its day entries', async () => {
      const queue = await h.api().get(`${API}/timesheets?status=submitted`).set('Authorization', `Bearer ${o.ownerToken}`).expect(200);
      const id = queue.body.data[0].id;
      const res = await h.api().get(`${API}/timesheets/${id}`).set('Authorization', `Bearer ${o.ownerToken}`).expect(200);
      expect(res.body.data.entries.length).toBeGreaterThan(0);
      expect(res.body.data.entries[0].date).toBe('2026-09-15');
      expect(Array.isArray(res.body.data.logs)).toBe(true);
      expect(res.body.data.employee.email).toBe(member.email);
    });
  });

  test('timesheets cannot be submitted when the policy is off', ({ given, when, then }) => {
    let member: Member;
    let status = 0;
    given('an organization with timesheets turned off and an employee member', async () => {
      ({ member } = await setup(false));
    });
    when('the employee tries to submit a timesheet', async () => {
      const res = await submit(member);
      status = res.status;
    });
    then('the submission is rejected', () => {
      expect(status).toBe(400);
    });
  });
});
