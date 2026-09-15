import { ForbiddenException } from '@nestjs/common';
import { MeetingsService } from './meetings.service';

describe('MeetingsService', () => {
  let meetingsRepo: any;
  let usersRepo: any;
  let notifier: { notify: jest.Mock };
  let config: { get: jest.Mock };
  let service: MeetingsService;
  const store = new Map<string, any>();

  const admin = { userId: 'admin1', isAdmin: true };
  const host = { userId: 'host1', isAdmin: false };
  const member = (id: string) => ({ userId: id, isAdmin: false });

  beforeEach(() => {
    store.clear();
    meetingsRepo = {
      create: jest.fn((v) => ({ ...v })),
      save: jest.fn((v) => {
        const rows = Array.isArray(v) ? v : [v];
        for (const r of rows) { r.id = r.id || 'm_' + store.size; r.createdAt = r.createdAt || new Date(); store.set(r.id, r); }
        return Promise.resolve(v);
      }),
      findOne: jest.fn(({ where }) => Promise.resolve(store.get(where.id) ?? null)),
      find: jest.fn(({ where }) => Promise.resolve([...store.values()].filter((m) => m.status === where.status && !m.isDeleted))),
    };
    usersRepo = {
      find: jest.fn(({ where }) => Promise.resolve((where.id?._value ?? where.id ?? []).map?.((id: string) => ({ id, firstName: id, lastName: 'U', email: `${id}@x.com` })) ?? [])),
      findOne: jest.fn(() => Promise.resolve({ firstName: 'Host', lastName: 'One', email: 'h@x.com' })),
    };
    // `In(ids)` returns a FindOperator; our mock reads its internal value list.
    usersRepo.find = jest.fn(({ where }) => {
      const op = where.id;
      const ids: string[] = op?._value ?? op?.value ?? [];
      return Promise.resolve(ids.map((id) => ({ id, firstName: id, lastName: 'U', email: `${id}@x.com` })));
    });
    notifier = { notify: jest.fn().mockResolvedValue(undefined) };
    config = { get: jest.fn(() => undefined) }; // meet.jit.si, no JWT
    const activity = { record: jest.fn().mockResolvedValue(undefined) };
    service = new MeetingsService(meetingsRepo as any, usersRepo as any, config as any, notifier as any, activity as any);
  });

  it('create: persists, notifies invitees (not the host), carries recurrence', async () => {
    const out = await service.create('orgA', host, { title: 'Weekly', participantIds: ['u2', 'u3'], recurrence: 'weekly' });
    expect(out.title).toBe('Weekly');
    expect(out.recurrence).toBe('weekly');
    expect(out.isHost).toBe(true);
    // notified u2 + u3 (host excluded)
    expect(notifier.notify).toHaveBeenCalledTimes(2);
    expect(out.roomName).toMatch(/^nxr-/);
  });

  it('join: flips a scheduled meeting to live and returns meet.jit.si config with no jwt', async () => {
    const m = await service.create('orgA', host, { title: 'Sync', participantIds: ['u2'] });
    const cfg = await service.join('orgA', host, m.id);
    expect(cfg.domain).toBe('meet.jit.si');
    expect(cfg.jwt).toBeNull();
    expect(cfg.moderator).toBe(true); // host is moderator
    expect(store.get(m.id).status).toBe('live');
  });

  it('access: a participant can open it; a stranger cannot', async () => {
    const m = await service.create('orgA', host, { title: 'Sync', participantIds: ['u2'] });
    await expect(service.get('orgA', member('u2'), m.id)).resolves.toMatchObject({ id: m.id });
    await expect(service.get('orgA', member('stranger'), m.id)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.get('orgA', admin, m.id)).resolves.toMatchObject({ id: m.id }); // admin sees all
  });

  it('addParticipants: host adds new people (deduped) + notifies; non-host is blocked', async () => {
    const m = await service.create('orgA', host, { title: 'Sync', participantIds: ['u2'] });
    notifier.notify.mockClear();
    const res = await service.addParticipants('orgA', host, m.id, ['u2', 'u4', 'u5']); // u2 already in
    expect(res.added).toBe(2); // only u4, u5
    expect(notifier.notify).toHaveBeenCalledTimes(2);
    await expect(service.addParticipants('orgA', member('u4'), m.id, ['u9'])).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('endStale: ends an abandoned live meeting but keeps a recurring room', async () => {
    const old = new Date(Date.now() - 24 * 3600 * 1000);
    const a = await service.instant('orgA', host, { title: 'abandoned' });
    store.get(a.meeting.id).startedAt = old; // make it stale
    const r = await service.create('orgA', host, { title: 'standing', recurrence: 'daily' });
    store.get(r.id).status = 'live'; store.get(r.id).startedAt = old;

    const ended = await service.endStale();
    expect(ended).toBe(1);
    expect(store.get(a.meeting.id).status).toBe('ended');
    expect(store.get(r.id).status).toBe('live'); // recurring persists
  });

  describe('incoming (join popup)', () => {
    const NOW = new Date('2026-09-15T10:00:00Z');
    const at = (min: number) => new Date(NOW.getTime() + min * 60_000);
    const seed = (over: any) => { const m = { organizationId: 'orgA', isDeleted: false, hostId: 'host1', hostName: 'Host One', title: 'x', participants: [{ userId: 'u2', name: 'u2' }], createdAt: at(-240), ...over }; store.set(m.id, m); return m; };
    beforeEach(() => {
      // incoming() filters status with In([...]); match on the operator's values.
      meetingsRepo.find = jest.fn(({ where }) => {
        const statuses: string[] = where.status?._value ?? where.status?.value ?? [where.status];
        return Promise.resolve([...store.values()].filter((m) => m.organizationId === where.organizationId && !m.isDeleted && statuses.includes(m.status)));
      });
    });

    it('returns live meetings and scheduled ones inside their window, only for invitees', async () => {
      seed({ id: 'live', status: 'live', isInstant: true });
      seed({ id: 'soon', status: 'scheduled', scheduledStart: at(4) });                      // 4 min away → in (5 min early window)
      seed({ id: 'running', status: 'scheduled', scheduledStart: at(-20), scheduledEnd: at(10) });
      seed({ id: 'later', status: 'scheduled', scheduledStart: at(30) });                    // too early
      seed({ id: 'over', status: 'scheduled', scheduledStart: at(-120), scheduledEnd: at(-60) });
      seed({ id: 'noEndOld', status: 'scheduled', scheduledStart: at(-90) });                // past default 60 min length
      seed({ id: 'undatedNew', status: 'scheduled', scheduledStart: null, createdAt: at(-10) });
      seed({ id: 'undatedOld', status: 'scheduled', scheduledStart: null, createdAt: at(-90) });
      seed({ id: 'ended', status: 'ended' });
      seed({ id: 'cancelled', status: 'cancelled', scheduledStart: at(0) });
      seed({ id: 'notInvited', status: 'live', participants: [{ userId: 'u9', name: 'u9' }] });
      seed({ id: 'otherOrg', status: 'live', organizationId: 'orgB' });

      const ids = (await service.incoming('orgA', member('u2'), NOW)).map((m) => m.id).sort();
      expect(ids).toEqual(['live', 'running', 'soon', 'undatedNew']);
    });

    it("doesn't pop up for the host, and admins only see meetings they're invited to", async () => {
      seed({ id: 'live', status: 'live' });
      expect(await service.incoming('orgA', host, NOW)).toEqual([]);
      expect(await service.incoming('orgA', admin, NOW)).toEqual([]);
    });
  });
});
