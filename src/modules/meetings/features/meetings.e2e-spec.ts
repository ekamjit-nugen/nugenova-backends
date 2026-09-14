import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import request from 'supertest';

import {
  bootOrgTestApp,
  OrgTestHarness,
  CreatedOrg,
} from '../../organization/features/support/org-harness';
import { MeetingEntity } from '../entities/meeting.entity';
import { NotificationEntity } from '../../notification/entities/notification.entity';

const feature = loadFeature('./meetings.feature', { loadRelativePath: true });
const API = '/api/v1';

interface Member {
  email: string;
  userId: string;
  token: string;
}

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let meetings: Repository<MeetingEntity>;
  let notifications: Repository<NotificationEntity>;
  const orgIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    meetings = h.app.get(getRepositoryToken(MeetingEntity));
    notifications = h.app.get(getRepositoryToken(NotificationEntity));
  });
  afterAll(async () => {
    const ids = [...orgIds];
    if (ids.length) {
      await meetings.delete({ organizationId: In(ids) }).catch(() => undefined);
      await notifications.delete({ organizationId: In(ids) }).catch(() => undefined);
    }
    await h.cleanup();
  });

  // The org owner is the meeting HOST (owner org-role ⇒ isAdmin). The colleague
  // is an invited employee; the stranger is an employee who is never invited.
  const setup = async (withStranger = false): Promise<{
    o: CreatedOrg;
    colleague: Member;
    stranger?: Member;
  }> => {
    const o = await h.createOrg();
    orgIds.add(o.orgId);
    const colleague = await h.createEmployeeMember(o);
    const stranger = withStranger ? await h.createEmployeeMember(o) : undefined;
    return { o, colleague, stranger };
  };

  const asHost = (o: CreatedOrg) => (path: string) =>
    h.api().post(`${API}${path}`).set('Authorization', `Bearer ${o.ownerToken}`);

  test('a member schedules a meeting and invites a colleague', ({ given, when, then, and }) => {
    let o: CreatedOrg;
    let colleague: Member;
    let res: request.Response;

    given('an organization with two members', async () => {
      ({ o, colleague } = await setup());
    });
    when('the host schedules a meeting inviting the colleague', async () => {
      res = await asHost(o)('/meetings').send({
        title: 'Roadmap review',
        scheduledStart: '2026-09-10T10:00:00.000Z',
        scheduledEnd: '2026-09-10T11:00:00.000Z',
        participantIds: [colleague.userId],
      });
    });
    then('the meeting is created as scheduled with the colleague invited', () => {
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('scheduled');
      expect(res.body.data.participants.map((p: any) => p.userId)).toContain(colleague.userId);
    });
    and('the colleague receives a meeting invite notification', async () => {
      const rows = await notifications.find({ where: { userId: colleague.userId, type: 'meeting_invited' } });
      expect(rows.length).toBeGreaterThan(0);
    });
  });

  test('the meeting list only shows meetings the caller can access', ({ given, when, then, and }) => {
    let o: CreatedOrg;
    let colleague: Member;
    let stranger: Member;
    let meetingId: string;

    given('an organization with two members and a stranger', async () => {
      const s = await setup(true);
      o = s.o; colleague = s.colleague; stranger = s.stranger!;
    });
    when('the host schedules a meeting inviting the colleague', async () => {
      const res = await asHost(o)('/meetings').send({ title: 'Sync', participantIds: [colleague.userId] });
      meetingId = res.body.data.id;
    });
    then('the colleague sees the meeting in their list', async () => {
      const res = await h.api().get(`${API}/meetings`).set('Authorization', `Bearer ${colleague.token}`).expect(200);
      expect(res.body.data.map((m: any) => m.id)).toContain(meetingId);
    });
    and('the stranger does not see the meeting in their list', async () => {
      const res = await h.api().get(`${API}/meetings`).set('Authorization', `Bearer ${stranger.token}`).expect(200);
      expect(res.body.data.map((m: any) => m.id)).not.toContain(meetingId);
    });
  });

  test('an invited member can open the meeting but a stranger cannot', ({ given, when, then, and }) => {
    let o: CreatedOrg;
    let colleague: Member;
    let stranger: Member;
    let meetingId: string;

    given('an organization with two members and a stranger', async () => {
      const s = await setup(true);
      o = s.o; colleague = s.colleague; stranger = s.stranger!;
    });
    when('the host schedules a meeting inviting the colleague', async () => {
      const res = await asHost(o)('/meetings').send({ title: 'Private sync', participantIds: [colleague.userId] });
      meetingId = res.body.data.id;
    });
    then('the colleague can open the meeting', async () => {
      await h.api().get(`${API}/meetings/${meetingId}`).set('Authorization', `Bearer ${colleague.token}`).expect(200);
    });
    and('opening it as the stranger is forbidden', async () => {
      // Same-org non-participant ⇒ 403 (a cross-org id would be 404).
      await h.api().get(`${API}/meetings/${meetingId}`).set('Authorization', `Bearer ${stranger.token}`).expect(403);
    });
  });

  test('the first join flips a scheduled meeting to live', ({ given, when, and, then }) => {
    let o: CreatedOrg;
    let colleague: Member;
    let meetingId: string;
    let join: request.Response;

    given('an organization with two members', async () => {
      ({ o, colleague } = await setup());
    });
    when('the host schedules a meeting inviting the colleague', async () => {
      const res = await asHost(o)('/meetings').send({ title: 'Standup', participantIds: [colleague.userId] });
      meetingId = res.body.data.id;
    });
    and('the colleague joins the meeting', async () => {
      join = await h.api().post(`${API}/meetings/${meetingId}/join`).set('Authorization', `Bearer ${colleague.token}`).expect(201);
    });
    then('the meeting becomes live and returns a room to join', async () => {
      expect(join.body.data.roomName).toBeTruthy();
      expect(join.body.data.status).toBe('live');
      const row = await meetings.findOne({ where: { id: meetingId } });
      expect(row?.status).toBe('live');
    });
  });

  test('only the host can cancel a meeting', ({ given, when, then, and }) => {
    let o: CreatedOrg;
    let colleague: Member;
    let meetingId: string;

    given('an organization with two members', async () => {
      ({ o, colleague } = await setup());
    });
    when('the host schedules a meeting inviting the colleague', async () => {
      const res = await asHost(o)('/meetings').send({ title: 'Review', participantIds: [colleague.userId] });
      meetingId = res.body.data.id;
    });
    then('the colleague cannot cancel the meeting', async () => {
      await h.api().post(`${API}/meetings/${meetingId}/cancel`).set('Authorization', `Bearer ${colleague.token}`).expect(403);
    });
    and('the host can cancel the meeting', async () => {
      const res = await asHost(o)(`/meetings/${meetingId}/cancel`).expect(201);
      expect(res.body.data.status).toBe('cancelled');
    });
  });

  test('the host adds a colleague to an ongoing meeting and duplicates are ignored', ({ given, when, and, then }) => {
    let o: CreatedOrg;
    let colleague: Member;
    let stranger: Member;
    let meetingId: string;
    let addRes: request.Response;

    given('an organization with two members and a stranger', async () => {
      const s = await setup(true);
      o = s.o; colleague = s.colleague; stranger = s.stranger!;
    });
    when('the host starts an instant meeting', async () => {
      const res = await asHost(o)('/meetings/instant').send({ title: 'Huddle' }).expect(201);
      meetingId = res.body.data.meeting.id;
    });
    and('the host adds the colleague and the stranger', async () => {
      addRes = await asHost(o)(`/meetings/${meetingId}/participants`)
        .send({ userIds: [colleague.userId, stranger.userId] })
        .expect(201);
    });
    then('two people are added to the meeting', () => {
      expect(addRes.body.data.added).toBe(2);
    });
    and('adding the colleague again adds no one', async () => {
      const again = await asHost(o)(`/meetings/${meetingId}/participants`)
        .send({ userIds: [colleague.userId] })
        .expect(201);
      expect(again.body.data.added).toBe(0);
    });
  });
});
