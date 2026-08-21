import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
// Load the same env the app + ConfigModule load (DATABASE_URL, JWT_SECRET,
// DEV_OTP_BYPASS, DEV_OTP_CODE, …). Must run before AppModule is imported.
loadEnv({ path: ['.env.local', '.env'] });

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import cookieParser from 'cookie-parser';
import { In, Repository } from 'typeorm';
import * as speakeasy from 'speakeasy';

import { AppModule } from '../../../../app.module';
import { UserEntity } from '../../entities/user.entity';
import { OrgMembershipEntity } from '../../entities/org-membership.entity';
import { SessionEntity } from '../../entities/session.entity';
import { RevokedTokenEntity } from '../../entities/revoked-token.entity';
import { newObjectId } from '../../../../bootstrap/database/object-id';

export interface TestHarness {
  app: INestApplication;
  users: Repository<UserEntity>;
  memberships: Repository<OrgMembershipEntity>;
  sessions: Repository<SessionEntity>;
  revokedTokens: Repository<RevokedTokenEntity>;
  /** Emails/ids created during the run — cleaned up by cleanup(). */
  track(user: UserEntity): UserEntity;
  cleanup(): Promise<void>;
}

/**
 * Boot an in-process Nest app that mirrors src/main.ts (cookie-parser, the same
 * global ValidationPipe, and the `api/v1` prefix) and expose the TypeORM repos
 * for fixture creation. Every test file gets its own app + connection; the
 * underlying Postgres is SHARED (Supabase locally, ephemeral in CI), so fixtures
 * use random emails and are torn down in afterAll.
 */
export async function bootTestApp(): Promise<TestHarness> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.setGlobalPrefix('api/v1');
  await app.init();

  const users = app.get<Repository<UserEntity>>(getRepositoryToken(UserEntity));
  const memberships = app.get<Repository<OrgMembershipEntity>>(
    getRepositoryToken(OrgMembershipEntity),
  );
  const sessions = app.get<Repository<SessionEntity>>(
    getRepositoryToken(SessionEntity),
  );
  const revokedTokens = app.get<Repository<RevokedTokenEntity>>(
    getRepositoryToken(RevokedTokenEntity),
  );

  const trackedUserIds: string[] = [];

  const harness: TestHarness = {
    app,
    users,
    memberships,
    sessions,
    revokedTokens,
    track(user: UserEntity) {
      trackedUserIds.push(user.id);
      return user;
    },
    async cleanup() {
      if (trackedUserIds.length) {
        // Order matters only loosely (no FKs), but clear child rows first.
        await memberships
          .delete({ userId: In(trackedUserIds) })
          .catch(() => undefined);
        await sessions
          .delete({ userId: In(trackedUserIds) })
          .catch(() => undefined);
        await revokedTokens
          .delete({ userId: In(trackedUserIds) })
          .catch(() => undefined);
        await users.delete({ id: In(trackedUserIds) }).catch(() => undefined);
      }
      await app.close();
    },
  };

  return harness;
}

/** Unique, collision-free email for a throwaway fixture. */
export function randomEmail(prefix = 'test'): string {
  return `${prefix}+${newObjectId()}@nugenova.test`;
}

export interface CreateUserOverrides extends Partial<UserEntity> {}

/**
 * Persist a User fixture with sane defaults for a completed, active account.
 * Callers override setupStage/isActive/isPlatformAdmin/mfa* as needed and MUST
 * pass the harness so the row is tracked for teardown.
 */
export async function createUser(
  h: TestHarness,
  overrides: CreateUserOverrides = {},
): Promise<UserEntity> {
  const entity = h.users.create({
    email: (overrides.email ?? randomEmail()).toLowerCase(),
    password: 'pending-otp-' + newObjectId(),
    firstName: overrides.firstName ?? 'Test',
    lastName: overrides.lastName ?? 'User',
    isActive: overrides.isActive ?? true,
    setupStage: overrides.setupStage ?? 'complete',
    roles: overrides.roles ?? ['user'],
    isPlatformAdmin: overrides.isPlatformAdmin ?? false,
    mfaEnabled: overrides.mfaEnabled ?? false,
    mfaSecret: overrides.mfaSecret ?? null,
    mfaMethod: overrides.mfaMethod ?? null,
    mfaBackupCodes: overrides.mfaBackupCodes ?? null,
    defaultOrganizationId: overrides.defaultOrganizationId ?? null,
    organizations: overrides.organizations ?? [],
  });
  // Apply any remaining raw overrides (otp fields, lockUntil, etc.).
  Object.assign(entity, overrides, {
    email: (overrides.email ?? entity.email).toLowerCase(),
  });
  const saved = await h.users.save(entity);
  return h.track(saved);
}

/** Persist an OrgMembership fixture for a user. */
export async function createMembership(
  h: TestHarness,
  userId: string,
  overrides: Partial<OrgMembershipEntity> = {},
): Promise<OrgMembershipEntity> {
  const entity = h.memberships.create({
    userId,
    organizationId: overrides.organizationId ?? newObjectId(),
    role: overrides.role ?? 'manager',
    status: overrides.status ?? 'active',
    email: overrides.email ?? null,
  });
  Object.assign(entity, overrides, { userId });
  return h.memberships.save(entity);
}

/** Build a valid 6-digit TOTP for a base32 secret (matches AuthService/speakeasy). */
export function totpFor(secret: string): string {
  return speakeasy.totp({ secret, encoding: 'base32' });
}

/** A base32 secret usable as a pre-provisioned mfaSecret in fixtures. */
export function newBase32Secret(): string {
  return speakeasy.generateSecret({ length: 20 }).base32;
}

export const DEV_OTP = process.env.DEV_OTP_CODE || '000000';
