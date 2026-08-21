import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';

// Same env the app + ConfigModule load.
loadEnv({ path: ['.env.local', '.env'] });

import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';

/**
 * TypeORM DataSource for the CLI (migrations) and the ETL scripts. The running
 * app uses PostgresModule; this file is for `migration:*` and `etl:*`.
 * `DIRECT_URL` overrides `DATABASE_URL` when migrations must run on a different
 * endpoint (with the Supabase session pooler they're the same, so DIRECT_URL
 * can stay unset).
 *
 * Exactly ONE DataSource export — the TypeORM CLI rejects a file that exports
 * the same DataSource twice.
 */
const url = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const isLocal = url.includes('localhost') || url.includes('127.0.0.1');

export const AppDataSource = new DataSource({
  type: 'postgres',
  url,
  ssl: url && !isLocal ? { rejectUnauthorized: false } : false,
  entities: ['src/modules/**/entities/*.entity.ts'],
  migrations: ['src/bootstrap/database/migrations/*.ts'],
  namingStrategy: new SnakeNamingStrategy(),
  synchronize: false,
});
