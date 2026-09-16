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
 */
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
          extra: { max: 10 },
        };
      },
    }),
  ],
})
export class PostgresModule {}
