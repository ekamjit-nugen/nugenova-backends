import { HealthController } from './health.controller';
import { DataSource } from 'typeorm';

/** A DataSource whose migrations table answers with `applied` and whose build carries `inBuild`. */
const ds = (opts: { applied?: number | null; inBuild?: number[]; fail?: boolean }) => ({
  migrations: (opts.inBuild ?? [1788610000000]).map((t) => ({ name: `Migration${t}` })),
  query: jest.fn((sql: string) => {
    if (opts.fail) return Promise.reject(new Error('boom'));
    if (sql.includes('migrations')) return Promise.resolve([{ applied: opts.applied ?? null }]);
    return Promise.resolve([{ n: 1 }]);
  }),
}) as unknown as DataSource;

describe('HealthController', () => {
  it('reports db:up when SELECT 1 succeeds', async () => {
    const res = await new HealthController(ds({ applied: 1788610000000 })).check();
    expect(res).toMatchObject({ status: 'ok', db: 'up', schema: 'match' });
    expect(typeof res.ts).toBe('string');
  });

  it('reports db:down when the query throws', async () => {
    const res = await new HealthController(ds({ fail: true })).check();
    expect(res.status).toBe('degraded');
    expect(res.db).toBe('down');
  });

  it('flags a build older than the schema it is talking to', async () => {
    // What a failed container swap looks like: migrations ran, the code did not.
    const res = await new HealthController(ds({ applied: 1788610000000, inBuild: [1788580000000] })).check();
    expect(res.schema).toBe('behind');
    expect(res.status).toBe('degraded');
  });

  it('flags migrations that have not been applied yet', async () => {
    const res = await new HealthController(ds({ applied: 1788580000000, inBuild: [1788610000000] })).check();
    expect(res.schema).toBe('ahead');
    expect(res.status).toBe('degraded');
  });

  it('stays ok when the schema cannot be compared', async () => {
    const res = await new HealthController(ds({ applied: null })).check();
    expect(res).toMatchObject({ status: 'ok', schema: 'unknown' });
  });

  it('reports the build it is running', async () => {
    process.env.APP_GIT_SHA = 'abc123';
    const res = await new HealthController(ds({ applied: 1788610000000 })).check();
    expect(res.version).toBe('abc123');
    delete process.env.APP_GIT_SHA;
  });
});
