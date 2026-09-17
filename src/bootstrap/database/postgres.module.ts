import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';

/**
 * The single Postgres (Supabase) connection — the ONLY datastore in this repo.
 *
 * Uses the default (unnamed) TypeORM connection: modules register entities with
 * `TypeOrmModule.forFeature([...])` and inject `@InjectRepository(Entity)` with
 * no connection name. Schema changes go through migrations only.
 *
 * Supabase: session pooler on :5432, TLS required (its pooler cert isn't in the
 * default CA bundle, so don't hard-verify). Local dev Postgres needs no TLS.
 *
 * Connection budget: Supabase's session pooler caps the whole project (e.g. 15
 * clients), shared by every API instance, rolling deploys, cron/ETL scripts and
 * migrations. Keep the per-process pool small (DB_POOL_MAX, default 5), release
 * idle clients quickly, and fail fast instead of queueing forever when the pool
 * is exhausted. For more headroom point DATABASE_URL at the transaction pooler
 * (:6543) — the app uses no session-level features — and keep DIRECT_URL on the
 * session pooler / direct host for migrations.
 */
const positiveInt = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => {
        const url = cfg.get<string>('DATABASE_URL') || '';
        const isLocal = url.includes('localhost') || url.includes('127.0.0.1');
        // Self-hosted/containerised Postgres speaks no TLS: `DB_SSL=false` or `?sslmode=disable`.
        const sslOff = String(cfg.get<string>('DB_SSL') ?? '').toLowerCase() === 'false' || /[?&]sslmode=disable/i.test(url);
        return {
          type: 'postgres',
          url,
          ssl: url && !isLocal && !sslOff ? { rejectUnauthorized: false } : false,
          autoLoadEntities: true,
          namingStrategy: new SnakeNamingStrategy(),
          synchronize: false,
          migrationsRun: false,
          retryAttempts: 3,
          retryDelay: 3000,
          extra: {
            max: positiveInt(cfg.get<string>('DB_POOL_MAX'), 5),
            idleTimeoutMillis: positiveInt(cfg.get<string>('DB_POOL_IDLE_MS'), 10_000),
            connectionTimeoutMillis: positiveInt(cfg.get<string>('DB_CONNECT_TIMEOUT_MS'), 15_000),
            application_name: cfg.get<string>('DB_APPLICATION_NAME') || 'nugenova-api',
          },
        };
      },
    }),
  ],
})
export class PostgresModule {}
