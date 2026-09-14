import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import request from 'supertest';

import {
  bootOrgTestApp,
  OrgTestHarness,
  CreatedOrg,
} from '../../organization/features/support/org-harness';
import { HolidayEntity } from '../../attendance/entities/holiday.entity';
import { LeaveRequestEntity } from '../../leave/entities/leave-request.entity';
import { MeetingEntity } from '../../meetings/entities/meeting.entity';

const feature = loadFeature('./calendar.feature', { loadRelativePath: true });
const API = '/api/v1';
const SEP_FROM = '2026-09-01T00:00:00.000Z';
const SEP_TO = '2026-09-30T23:59:59.999Z';

interface Member {
  email: string;
  userId: string;
  token: string;
}

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let holidays: Repository<HolidayEntity>;
  let leaves: Repository<LeaveRequestEntity>;
  let meetings: Repository<MeetingEntity>;
  const orgIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    holidays = h.app.get(getRepositoryToken(HolidayEntity));
    leaves = h.app.get(getRepositoryToken(LeaveRequestEntity));
    meetings = h.app.get(getRepositoryToken(MeetingEntity));
  });
  afterAll(async () => {
    const ids = [...orgIds];
    if (ids.length) {
      await holidays.delete({ organizationId: In(ids) }).catch(() => undefined);
      await leaves.delete({ organizationId: In(ids) }).catch(() => undefined);
      await meetings.delete({ organizationId: In(ids) }).catch(() => undefined);
    }
    await h.cleanup();
  });

  const orgWithMember = async (withStranger = false): Promise<{ o: CreatedOrg; member: Member; stranger?: Member }> => {
    const o = await h.createOrg();
    orgIds.add(o.orgId);
    const member = await h.createEmployeeMember(o);
    const stranger = withStranger ? await h.createEmployeeMember(o) : undefined;
    return { o, member, stranger };
  };

  const readCalendar = (token: string) =>
    h.api().get(`${API}/calendar?from=${SEP_FROM}&to=${SEP_TO}`).set('Authorization', `Bearer ${token}`);

  const seedApprovedLeave = (o: CreatedOrg, m: Member, leaveType: string) =>
    leaves.save(leaves.create({
      organizationId: o.orgId,
      userId: m.userId,
      employeeName: null, // force name resolution from the users table
      leaveType,
      startDate: new Date('2026-09-14T00:00:00.000Z'),
      endDate: new Date('2026-09-14T00:00:00.000Z'),
      totalDays: 1,
      halfDay: false,
      reason: 'seeded',
      status: 'approved',
      isDeleted: false,
    }));

  test('holidays in the window appear on the calendar', ({ given, and, when, then }) => {
    let o: CreatedOrg;
    let member: Member;
    let res: request.Response;

    given('an organization with a member', async () => { ({ o, member } = await orgWithMember()); });
    and('a company holiday in September', async () => {
      await holidays.save(holidays.create({
        organizationId: o.orgId, date: new Date('2026-09-15T00:00:00.000Z'),
        name: 'Founders Day', type: 'other', year: 2026, isDeleted: false,
      }));
    });
    when('the member reads the calendar for September', async () => {
      res = await readCalendar(member.token).expect(200);
    });
    then('the holiday appears as an all-day holiday event', () => {
      const holiday = (res.body.data as any[]).find((e) => e.type === 'holiday' && e.title === 'Founders Day');
      expect(holiday).toBeTruthy();
      expect(holiday.allDay).toBe(true);
    });
  });

  test('approved leave shows the member\'s real name', ({ given, and, when, then }) => {
    let o: CreatedOrg;
    let member: Member;
    let res: request.Response;

    given('an organization with a member', async () => { ({ o, member } = await orgWithMember()); });
    and('the member has an approved casual leave in September', async () => {
      await seedApprovedLeave(o, member, 'casual');
    });
    when('the member reads the calendar for September', async () => {
      res = await readCalendar(member.token).expect(200);
    });
    then('a leave event shows the member\'s name', () => {
      const leave = (res.body.data as any[]).find((e) => e.type === 'leave');
      expect(leave).toBeTruthy();
      expect(leave.title).toContain('Emp'); // createEmployeeMember → "Emp Loyee"
    });
  });

  test('working from home is its own event type', ({ given, and, when, then }) => {
    let o: CreatedOrg;
    let member: Member;
    let res: request.Response;

    given('an organization with a member', async () => { ({ o, member } = await orgWithMember()); });
    and('the member has an approved work-from-home day in September', async () => {
      await seedApprovedLeave(o, member, 'wfh');
    });
    when('the member reads the calendar for September', async () => {
      res = await readCalendar(member.token).expect(200);
    });
    then('a work-from-home event appears separate from leave', () => {
      const events = res.body.data as any[];
      expect(events.some((e) => e.type === 'wfh')).toBe(true);
      expect(events.some((e) => e.type === 'leave')).toBe(false);
    });
  });

  test('the calendar only shows meetings the caller can access', ({ given, and, when, then, but }) => {
    let o: CreatedOrg;
    let member: Member;
    let stranger: Member;
    let meetingId: string;

    given('an organization with a member and a stranger', async () => {
      const s = await orgWithMember(true);
      o = s.o; member = s.member; stranger = s.stranger!;
    });
    and('the host schedules a September meeting inviting the member', async () => {
      const res = await h.api().post(`${API}/meetings`)
        .set('Authorization', `Bearer ${o.ownerToken}`)
        .send({ title: 'Sept sync', scheduledStart: '2026-09-09T10:00:00.000Z', scheduledEnd: '2026-09-09T11:00:00.000Z', participantIds: [member.userId] })
        .expect(201);
      meetingId = res.body.data.id;
    });
    when('the member reads the calendar for September', async () => { /* asserted below */ });
    then('the member sees the meeting on the calendar', async () => {
      const res = await readCalendar(member.token).expect(200);
      const ids = (res.body.data as any[]).filter((e) => e.type === 'meeting').map((e) => e.meta?.meetingId);
      expect(ids).toContain(meetingId);
    });
    but('when the stranger reads the calendar the meeting is hidden', async () => {
      const res = await readCalendar(stranger.token).expect(200);
      const ids = (res.body.data as any[]).filter((e) => e.type === 'meeting').map((e) => e.meta?.meetingId);
      expect(ids).not.toContain(meetingId);
    });
  });

  test('a weekly meeting is expanded into several occurrences', ({ given, and, when, then }) => {
    let o: CreatedOrg;
    let member: Member;
    let meetingId: string;
    let res: request.Response;

    given('an organization with a member', async () => { ({ o, member } = await orgWithMember()); });
    and('the host schedules a weekly meeting starting in early September', async () => {
      const create = await h.api().post(`${API}/meetings`)
        .set('Authorization', `Bearer ${o.ownerToken}`)
        .send({ title: 'Weekly standup', scheduledStart: '2026-09-01T09:00:00.000Z', scheduledEnd: '2026-09-01T09:30:00.000Z', recurrence: 'weekly', participantIds: [member.userId] })
        .expect(201);
      meetingId = create.body.data.id;
    });
    when('the host reads the calendar for September', async () => {
      res = await readCalendar(o.ownerToken).expect(200);
    });
    then('the meeting appears on several days that month', () => {
      const occ = (res.body.data as any[]).filter((e) => e.type === 'meeting' && e.meta?.meetingId === meetingId);
      expect(occ.length).toBeGreaterThanOrEqual(3);
    });
  });

  test('a birthday appears from the member\'s date of birth', ({ given, and, when, then }) => {
    let o: CreatedOrg;
    let member: Member;
    let res: request.Response;

    given('an organization with a member', async () => { ({ o, member } = await orgWithMember()); });
    and('the member has a birthday in September', async () => {
      await h.users.update(member.userId, { dateOfBirth: new Date('1990-09-20T00:00:00.000Z') });
    });
    when('the member reads the calendar for September', async () => {
      res = await readCalendar(member.token).expect(200);
    });
    then('a birthday event appears for the member', () => {
      const bday = (res.body.data as any[]).find((e) => e.type === 'birthday' && e.meta?.userId === member.userId);
      expect(bday).toBeTruthy();
    });
  });
});
