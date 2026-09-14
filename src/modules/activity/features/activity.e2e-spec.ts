import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import request from 'supertest';

import {
  bootOrgTestApp,
  OrgTestHarness,
  CreatedOrg,
} from '../../organization/features/support/org-harness';
import { ActivityEventEntity } from '../entities/activity-event.entity';
import { ActivityRetentionRunEntity } from '../entities/activity-retention-run.entity';
import { MeetingEntity } from '../../meetings/entities/meeting.entity';
import { EmailOutboxEntity } from '../../../bootstrap/mail/email-outbox.entity';

// Use the persist-only mail driver so the retention backup "delivers" (queued)
// without real SMTP — mirrors CI. Set before the app boots in beforeAll.
process.env.MAIL_DRIVER = 'outbox';

const feature = loadFeature('./activity.feature', { loadRelativePath: true });
const API = '/api/v1';

interface Member { email: string; userId: string; token: string }

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let activity: Repository<ActivityEventEntity>;
  let runs: Repository<ActivityRetentionRunEntity>;
  let meetings: Repository<MeetingEntity>;
  let outbox: Repository<EmailOutboxEntity>;
  const orgIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    activity = h.app.get(getRepositoryToken(ActivityEventEntity));
    runs = h.app.get(getRepositoryToken(ActivityRetentionRunEntity));
    meetings = h.app.get(getRepositoryToken(MeetingEntity));
    outbox = h.app.get(getRepositoryToken(EmailOutboxEntity));
  });
  afterAll(async () => {
    const ids = [...orgIds];
    if (ids.length) {
      await activity.delete({ organizationId: In(ids) }).catch(() => undefined);
      await runs.delete({ organizationId: In(ids) }).catch(() => undefined);
      await meetings.delete({ organizationId: In(ids) }).catch(() => undefined);
      await outbox.delete({ organizationId: In(ids) }).catch(() => undefined);
    }
    await h.cleanup();
  });

  const setup = async (): Promise<{ o: CreatedOrg; member: Member }> => {
    const o = await h.createOrg();
    orgIds.add(o.orgId);
    const member = await h.createEmployeeMember(o);
    return { o, member };
  };

  test('a member\'s action is captured in the activity feed', ({ given, when, then }) => {
    let o: CreatedOrg;
    given('an organization with an owner and a member', async () => { ({ o } = await setup()); });
    when('the owner schedules a meeting', async () => {
      await h.api().post(`${API}/meetings`).set('Authorization', `Bearer ${o.ownerToken}`).send({ title: 'Sync' }).expect(201);
    });
    then('the owner\'s activity feed shows a meetings event', async () => {
      const res = await h.api().get(`${API}/activity?limit=20`).set('Authorization', `Bearer ${o.ownerToken}`).expect(200);
      const cats = (res.body.items as any[]).map((e) => e.category);
      expect(cats).toContain('meetings');
    });
  });

  test('members only see their own activity', ({ given, when, then }) => {
    let o: CreatedOrg;
    let member: Member;
    given('an organization with an owner and a member', async () => { ({ o, member } = await setup()); });
    when('the owner schedules a meeting', async () => {
      await h.api().post(`${API}/meetings`).set('Authorization', `Bearer ${o.ownerToken}`).send({ title: 'Owners only' }).expect(201);
    });
    then('the member\'s activity feed does not show the owner\'s event', async () => {
      const res = await h.api().get(`${API}/activity?limit=20`).set('Authorization', `Bearer ${member.token}`).expect(200);
      const ownerEvents = (res.body.items as any[]).filter((e) => e.actorId === o.ownerId);
      expect(ownerEvents).toHaveLength(0);
    });
  });

  test('retention archives old logs to the owner and purges them', ({ given, and, when, then }) => {
    let o: CreatedOrg;
    given('an organization with an owner and a member', async () => { ({ o } = await setup()); });
    and('there are activity logs older than 15 days', async () => {
      const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
      const saved = await activity.save([
        activity.create({ organizationId: o.orgId, actorId: o.ownerId, actorName: 'Owner', action: 'auth.login', category: 'auth', summary: 'Logged in', metadata: {} }),
        activity.create({ organizationId: o.orgId, actorId: o.ownerId, actorName: 'Owner', action: 'file.uploaded', category: 'files', summary: 'Uploaded x', metadata: {} }),
      ]);
      // @CreateDateColumn ignores an explicit createdAt on both insert and
      // entity-update — backdate with raw SQL.
      await activity.query('UPDATE activity_events SET created_at = $1 WHERE id = ANY($2)', [old, saved.map((r) => r.id)]);
    });
    when('the owner runs retention', async () => {
      const res = await h.api().post(`${API}/activity/retention/run`).set('Authorization', `Bearer ${o.ownerToken}`).expect(201);
      expect(res.body.data.archived).toBeGreaterThanOrEqual(2);
    });
    then('the old logs are emailed to the owner and removed', async () => {
      // The two backdated rows are gone.
      const remaining = await activity.count({ where: { organizationId: o.orgId, category: In(['auth', 'files']) } });
      expect(remaining).toBe(0);
      // A backup email was produced for the org.
      const mails = await outbox.find({ where: { organizationId: o.orgId, category: 'activity.retention_backup' } });
      expect(mails.length).toBeGreaterThanOrEqual(1);
    });
  });
});
