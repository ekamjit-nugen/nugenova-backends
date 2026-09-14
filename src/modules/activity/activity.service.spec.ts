import { ActivityService } from './activity.service';

describe('ActivityService (unit, no DB)', () => {
  let eventsRepo: any;
  let usersRepo: any;
  let service: ActivityService;
  const saved: any[] = [];

  beforeEach(() => {
    saved.length = 0;
    eventsRepo = {
      create: jest.fn((v) => ({ ...v })),
      save: jest.fn((v) => { saved.push(v); return Promise.resolve({ id: 'a1', ...v }); }),
      findAndCount: jest.fn(() => Promise.resolve([[], 0])),
    };
    usersRepo = { findOne: jest.fn(() => Promise.resolve({ firstName: 'Emp', lastName: 'Loyee', email: 'e@x.com' })) };
    service = new ActivityService(eventsRepo, usersRepo);
  });

  it('record: persists the event and resolves the actor name when omitted', async () => {
    await service.record({ organizationId: 'orgA', actorId: 'u1', action: 'leave.applied', category: 'leave' });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ organizationId: 'orgA', actorId: 'u1', action: 'leave.applied', category: 'leave', actorName: 'Emp Loyee' });
  });

  it('record: never throws — a repo failure is swallowed', async () => {
    eventsRepo.save.mockRejectedValueOnce(new Error('db down'));
    await expect(service.record({ organizationId: 'orgA', action: 'ai.used', category: 'ai' })).resolves.toBeUndefined();
  });

  it('record: skips when org or action is missing', async () => {
    await service.record({ organizationId: '', action: 'x', category: 'other' });
    await service.record({ organizationId: 'orgA', action: '', category: 'other' });
    expect(eventsRepo.save).not.toHaveBeenCalled();
  });

  it('list: a non-admin is force-scoped to their own activity', async () => {
    await service.list('orgA', { userId: 'u1', isAdmin: false }, { scope: 'all', actorId: 'someoneElse' });
    const where = eventsRepo.findAndCount.mock.calls[0][0].where;
    expect(where.actorId).toBe('u1'); // ignores the requested scope/actor
    expect(where.organizationId).toBe('orgA');
  });

  it('list: an admin can read the whole org and filter by actor', async () => {
    await service.list('orgA', { userId: 'admin', isAdmin: true }, { scope: 'all', actorId: 'u9', category: 'meetings' });
    const where = eventsRepo.findAndCount.mock.calls[0][0].where;
    expect(where.actorId).toBe('u9');
    expect(where.category).toBe('meetings');
  });

  it('list: clamps the page size', async () => {
    await service.list('orgA', { userId: 'admin', isAdmin: true }, { limit: 9999 });
    const opts = eventsRepo.findAndCount.mock.calls[0][0];
    expect(opts.take).toBeLessThanOrEqual(100);
  });
});
