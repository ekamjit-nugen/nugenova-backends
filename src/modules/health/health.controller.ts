import { Controller, Get } from '@nestjs/common';
import { DataSource } from 'typeorm';

/** `DropPremergeTables1788610000000` → 1788610000000. */
const timestampOf = (name: string): number => Number(/(\d{10,})$/.exec(name)?.[1] ?? 0);

/** Where the running build stands against the database it is talking to. */
export type SchemaState = 'match' | 'ahead' | 'behind' | 'unknown';

@Controller('health')
export class HealthController {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Liveness, DB readiness, and — the part that matters after a deploy — whether
   * this build's migrations line up with the ones the database has applied.
   *
   * A container serving code older than its schema answers every request with a
   * 500 ("relation … does not exist") while looking perfectly alive, which is
   * exactly what happened on 2026-09-18: migrations landed, the container swap
   * didn't. `schema: "behind"` names that state so the deploy can fail on it.
   *
   * Always HTTP 200: the compose healthcheck and nginx must not restart or
   * de-pool a process over a mismatch a human has to resolve.
   */
  @Get()
  async check(): Promise<{ status: string; db: string; schema: SchemaState; version: string; ts: string }> {
    let db = 'down';
    let schema: SchemaState = 'unknown';
    try {
      await this.dataSource.query('SELECT 1');
      db = 'up';
      schema = await this.schemaState();
    } catch {
      db = 'down';
    }
    return {
      status: db === 'up' && (schema === 'match' || schema === 'unknown') ? 'ok' : 'degraded',
      db,
      schema,
      version: process.env.APP_GIT_SHA || 'unknown',
      ts: new Date().toISOString(),
    };
  }

  /** Highest migration in this build vs. the highest the database has applied. */
  private async schemaState(): Promise<SchemaState> {
    try {
      const inBuild = this.dataSource.migrations.reduce(
        (max, m) => Math.max(max, timestampOf((m as { name?: string }).name || m.constructor.name)),
        0,
      );
      const [row] = await this.dataSource.query('SELECT max("timestamp")::bigint AS applied FROM migrations');
      const applied = Number(row?.applied ?? 0);
      if (!inBuild || !applied) return 'unknown';
      if (applied > inBuild) return 'behind';
      if (applied < inBuild) return 'ahead';
      return 'match';
    } catch {
      return 'unknown';
    }
  }
}
