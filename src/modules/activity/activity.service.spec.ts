import { BadRequestException } from '@nestjs/common';
import { ActivityService } from './activity.service';

/** A query builder double that records every condition and parameter. */
function fakeQueryBuilder(result: { many?: any[]; count?: number; raw?: any[] } = {}) {
  const calls = { where: [] as string[], params: {} as Record<string, unknown>, take: 0, skip: 0 };
  const qb: any = {
    where: jest.fn((sql: string, p?: object) => { calls.where.push(sql); Object.assign(calls.params, p); return qb; }),
    andWhere: jest.fn((sql: string, p?: object) => { calls.where.push(sql); Object.assign(calls.params, p); return qb; }),
    orderBy: jest.fn(() => qb),
    skip: jest.fn((n: number) => { calls.skip = n; return qb; }),
    take: jest.fn((n: number) => { calls.take = n; return qb; }),
    select: jest.fn(() => qb),
    addSelect: jest.fn(() => qb),
    groupBy: jest.fn(() => qb),
    getManyAndCount: jest.fn(() => Promise.resolve([result.many ?? [], result.count ?? 0])),
    getRawMany: jest.fn(() => Promise.resolve(result.raw ?? [])),
  };
  return { qb, calls };
}

describe('ActivityService (unit, no DB)', () => {
  let eventsRepo: any;
  let usersRepo: any;
  let service: ActivityService;
  const saved: any[] = [];
  let builder: ReturnType<typeof fakeQueryBuilder>;

  beforeEach(() => {
    saved.length = 0;
    builder = fakeQueryBuilder();
    eventsRepo = {
      create: jest.fn((v) => ({ ...v })),
      save: jest.fn((v) => { saved.push(v); return Promise.resolve({ id: 'a1', ...v }); }),
      createQueryBuilder: jest.fn(() => builder.qb),
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
    expect(builder.calls.params).toMatchObject({ orgId: 'orgA', me: 'u1' }); // ignores the requested scope/actor
    expect(builder.calls.params.actorId).toBeUndefined();
  });

  it('list: an admin can read the whole org and filter by actor', async () => {
    await service.list('orgA', { userId: 'admin', isAdmin: true }, { scope: 'all', actorId: 'u9', category: 'meetings' });
    expect(builder.calls.params).toMatchObject({ actorId: 'u9', category: 'meetings' });
    expect(builder.calls.params.me).toBeUndefined();
  });

  it('list: clamps the page size', async () => {
    await service.list('orgA', { userId: 'admin', isAdmin: true }, { limit: 9999 });
    expect(builder.calls.take).toBeLessThanOrEqual(100);
  });

  it('list: filters errors by area, matching the stored area or the old path segment', async () => {
    await service.list('orgA', { userId: 'admin', isAdmin: true }, { area: 'attendance' });
    expect(builder.calls.params).toMatchObject({ errors: 'errors', keys: ['attendance', 'attendance', 'holidays', 'timesheets'] });
  });

  it("list: 'other' means errors outside every known area", async () => {
    await service.list('orgA', { userId: 'admin', isAdmin: true }, { area: 'other' });
    const known = builder.calls.params.known as string[];
    expect(known).toEqual(expect.arrayContaining(['recruitment', 'leaves', 'auth']));
    expect(known).not.toContain('other');
  });

  it('list: refuses an unknown area', async () => {
    await expect(service.list('orgA', { userId: 'admin', isAdmin: true }, { area: 'nope' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('errorAreas: groups old path segments and new area keys into areas, in a fixed order', async () => {
    builder = fakeQueryBuilder({
      raw: [
        { segment: 'recruitment', count: 3 }, // new rows store the area
        { segment: 'timesheets', count: 2 }, // old rows: path segment
        { segment: 'attendance', count: 1 },
        { segment: 'vertical', count: 1 }, // not a known area
      ],
    });
    const areas = await service.errorAreas('orgA', { userId: 'admin', isAdmin: true }, {});
    expect(areas).toEqual([
      { key: 'recruitment', label: 'Recruitment', count: 3 },
      { key: 'attendance', label: 'Attendance & timesheets', count: 3 },
      { key: 'other', label: 'Other', count: 1 },
    ]);
  });

  it('errorAreas: a non-admin counts only their own errors', async () => {
    await service.errorAreas('orgA', { userId: 'u1', isAdmin: false }, { scope: 'all' });
    expect(builder.calls.params).toMatchObject({ me: 'u1', errors: 'errors' });
  });
});
