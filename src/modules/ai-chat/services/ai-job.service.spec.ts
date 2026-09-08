import { AiJobEntity } from '../entities/ai-job.entity';
import { AiJobService, ORPHAN_AGE_MS } from './ai-job.service';
import { FakeRepo } from './test-fake-repo';

/** Let a `setImmediate`-scheduled worker run, then settle its promises. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('AiJobService', () => {
  let repo: FakeRepo<AiJobEntity>;
  let service: AiJobService;

  beforeEach(() => {
    repo = new FakeRepo<AiJobEntity>();
    service = new AiJobService(repo as any);
  });

  it('submit() persists a queued row and returns WITHOUT running the worker', async () => {
    const worker = jest.fn().mockResolvedValue({ ok: true });
    service.registerWorker('chat', worker);

    const job = await service.submit({
      organizationId: 'orgA',
      userId: 'u1',
      kind: 'chat',
      input: { foo: 'bar' },
    });

    // Returned immediately as 'queued' — the worker has NOT run yet.
    expect(job.status).toBe('queued');
    expect(worker).not.toHaveBeenCalled();
    expect(repo.rows).toHaveLength(1);
  });

  it('runs the worker off the request path and marks the job done(result)', async () => {
    const worker = jest.fn().mockResolvedValue({ answer: 42 });
    service.registerWorker('chat', worker);

    const job = await service.submit({ organizationId: 'orgA', userId: 'u1', kind: 'chat', input: {} });
    await flush();

    expect(worker).toHaveBeenCalledTimes(1);
    const row = await repo.findOne({ where: { id: job.id } });
    expect(row?.status).toBe('done');
    expect(row?.result).toEqual({ answer: 42 });
    expect(row?.completedAt).toBeInstanceOf(Date);
  });

  it('marks the job error when the worker throws', async () => {
    service.registerWorker('chat', jest.fn().mockRejectedValue(new Error('boom')));

    const job = await service.submit({ organizationId: 'orgA', userId: 'u1', kind: 'chat', input: {} });
    await flush();

    const row = await repo.findOne({ where: { id: job.id } });
    expect(row?.status).toBe('error');
    expect(row?.errorMessage).toBeTruthy();
  });

  it('errors a job whose kind has no registered worker', async () => {
    const job = await service.submit({ organizationId: 'orgA', userId: 'u1', kind: 'chat', input: {} });
    await flush();
    const row = await repo.findOne({ where: { id: job.id } });
    expect(row?.status).toBe('error');
  });

  it('reapOrphans() errors stale queued/running rows, leaves fresh ones', async () => {
    const old = new Date(Date.now() - ORPHAN_AGE_MS - 1000);
    const fresh = new Date();
    repo.rows.push(
      { id: 'j1', status: 'queued', createdAt: old } as AiJobEntity,
      { id: 'j2', status: 'running', createdAt: old } as AiJobEntity,
      { id: 'j3', status: 'queued', createdAt: fresh } as AiJobEntity,
      { id: 'j4', status: 'done', createdAt: old } as AiJobEntity,
    );

    const n = await service.reapOrphans();

    expect(n).toBe(2);
    expect((await repo.findOne({ where: { id: 'j1' } }))?.status).toBe('error');
    expect((await repo.findOne({ where: { id: 'j2' } }))?.status).toBe('error');
    expect((await repo.findOne({ where: { id: 'j3' } }))?.status).toBe('queued');
    expect((await repo.findOne({ where: { id: 'j4' } }))?.status).toBe('done');
  });
});
