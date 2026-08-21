import { HealthController } from './health.controller';
import { DataSource } from 'typeorm';

describe('HealthController', () => {
  it('reports db:up when SELECT 1 succeeds', async () => {
    const ds = { query: jest.fn().mockResolvedValue([{ n: 1 }]) } as unknown as DataSource;
    const res = await new HealthController(ds).check();
    expect(res.status).toBe('ok');
    expect(res.db).toBe('up');
    expect(typeof res.ts).toBe('string');
  });

  it('reports db:down when the query throws', async () => {
    const ds = { query: jest.fn().mockRejectedValue(new Error('boom')) } as unknown as DataSource;
    const res = await new HealthController(ds).check();
    expect(res.status).toBe('ok');
    expect(res.db).toBe('down');
  });
});
