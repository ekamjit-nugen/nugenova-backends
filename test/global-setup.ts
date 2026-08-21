import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
// Same env the app loads. Must run before we read DATABASE_URL.
loadEnv({ path: ['.env.local', '.env'] });

import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';

import { UserEntity } from '../src/modules/auth/entities/user.entity';
import { OrgMembershipEntity } from '../src/modules/auth/entities/org-membership.entity';
import { SessionEntity } from '../src/modules/auth/entities/session.entity';
import { RoleEntity } from '../src/modules/auth/entities/role.entity';
import { RevokedTokenEntity } from '../src/modules/auth/entities/revoked-token.entity';
import { AuthUsersInitial1787316090532 } from '../src/bootstrap/database/migrations/1787316090532-AuthUsersInitial';
import { AuthSessionsRolesTokens1787334496372 } from '../src/bootstrap/database/migrations/1787334496372-AuthSessionsRolesTokens';

/**
 * Jest globalSetup for the e2e suite. Runs ONCE before the app boots and makes
 * the auth schema exist on whatever DATABASE_URL points at:
 *
 *  - Supabase (local .env.local): `users` + `org_memberships` already exist from
 *    the ETL and the auth migration has already run, so this is effectively a
 *    no-op — it only fills any gap.
 *  - Ephemeral empty Postgres (CI): NOTHING exists yet. The auth migration only
 *    provisions sessions/roles/revoked_tokens (users/org_memberships pre-exist on
 *    Supabase and were never captured in a migration in this repo), so on an
 *    empty DB we build the full auth schema from the entity metadata instead.
 *
 * Mirrors data-source.ts's connection/ssl logic but references the entity/
 * migration CLASSES directly — the string globs data-source.ts uses can't be
 * required as `.ts` from inside TypeORM under ts-jest.
 */
module.exports = async function globalSetup(): Promise<void> {
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set — e2e tests need a Postgres connection string.',
    );
  }
  const isLocal = url.includes('localhost') || url.includes('127.0.0.1');

  const ds = new DataSource({
    type: 'postgres',
    url,
    ssl: url && !isLocal ? { rejectUnauthorized: false } : false,
    entities: [
      UserEntity,
      OrgMembershipEntity,
      SessionEntity,
      RoleEntity,
      RevokedTokenEntity,
    ],
    migrations: [
      AuthUsersInitial1787316090532,
      AuthSessionsRolesTokens1787334496372,
    ],
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: false,
  });

  await ds.initialize();
  try {
    // Idempotent: TypeORM skips migrations already recorded in the `migrations`
    // table. On populated Supabase both auth migrations are already logged, so
    // this is a no-op; on an empty CI Postgres both run and provision the full
    // auth schema (users + org_memberships, then sessions/roles/revoked_tokens).
    await ds.runMigrations();
  } finally {
    await ds.destroy();
  }
};
