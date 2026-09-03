import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
// Load the same env the app + ConfigModule load (DATABASE_URL, JWT_SECRET,
// DEV_OTP_BYPASS, DEV_OTP_CODE, …). Must run before AppModule is imported.
loadEnv({ path: ['.env.local', '.env'] });

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { In, ObjectLiteral, Repository } from 'typeorm';

import { AppModule } from '../../../../app.module';
import { UserEntity } from '../../../auth/entities/user.entity';
import { OrgMembershipEntity } from '../../../auth/entities/org-membership.entity';
import { SessionEntity } from '../../../auth/entities/session.entity';
import { RevokedTokenEntity } from '../../../auth/entities/revoked-token.entity';
import { RoleEntity } from '../../../auth/entities/role.entity';
import { OrganizationEntity } from '../../entities/organization.entity';
import { DepartmentEntity } from '../../entities/department.entity';
import { PlatformTermsEntity } from '../../../terms/entities/platform-terms.entity';
import { newObjectId } from '../../../../bootstrap/database/object-id';

export const DEV_OTP = process.env.DEV_OTP_CODE || '000000';

export interface CreatedOrg {
  orgId: string;
  slug: string;
  ownerId: string;
  ownerEmail: string;
  ownerToken: string;
  saToken: string;
  /** The T&C document assigned to this org at creation. */
  termsId: string;
}

export interface OrgTestHarness {
  app: INestApplication;
  users: Repository<UserEntity>;
  memberships: Repository<OrgMembershipEntity>;
  organizations: Repository<OrganizationEntity>;
  departments: Repository<DepartmentEntity>;
  roles: Repository<RoleEntity>;
  sessions: Repository<SessionEntity>;
  revokedTokens: Repository<RevokedTokenEntity>;
  platformTerms: Repository<PlatformTermsEntity>;

  /** Issue an authenticated request (supertest) against the booted app. */
  api(): ReturnType<typeof request>;
  /** Mint an access token for an existing user via the OTP dev-bypass flow. */
  mintToken(email: string): Promise<string>;
  /** Persist a super-admin fixture and return { email, token }. */
  createSuperAdmin(): Promise<{ id: string; email: string; token: string }>;
  /** Provision an org (as super admin) + log its owner in — consent NOT accepted. */
  provisionOrg(name?: string): Promise<CreatedOrg>;
  /** Provision an org AND accept the T&C consent, so /org/* is reachable. */
  createOrg(name?: string): Promise<CreatedOrg>;
  /** Accept the current T&C for an org, as its owner. */
  acceptConsent(org: CreatedOrg): Promise<void>;
  /** Add an employee-tier member to an org (as its owner) + log them in. */
  createEmployeeMember(
    org: CreatedOrg,
  ): Promise<{ email: string; userId: string; token: string }>;

  /** Create a T&C document (as super admin) and return its id. */
  createTerms(saToken: string, title?: string): Promise<string>;

  /** Register ids for teardown. */
  trackUser(id: string): void;
  trackOrg(id: string): void;
  trackTerms(id: string): void;

  cleanup(): Promise<void>;
}

/** Unique, collision-free email for a throwaway fixture. */
export function randomEmail(prefix = 'org'): string {
  return `${prefix}+${newObjectId()}@nugenova.test`;
}

/** Unique org name so the derived slug + (org,name) uniqueness never collide. */
export function randomOrgName(prefix = 'Acme'): string {
  return `${prefix} ${newObjectId()}`;
}

/**
 * Boot an in-process Nest app mirroring src/main.ts (cookie-parser, the global
 * ValidationPipe, the `api/v1` prefix) and expose every TypeORM repo the org
 * suite touches. The underlying Postgres is SHARED (Supabase locally, ephemeral
 * in CI), so all fixtures use random emails/names and are torn down in afterAll
 * by tracked id — nothing is truncated.
 */
export async function bootOrgTestApp(): Promise<OrgTestHarness> {
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

  const repo = <T extends ObjectLiteral>(e: any): Repository<T> =>
    app.get<Repository<T>>(getRepositoryToken(e));

  const users = repo<UserEntity>(UserEntity);
  const memberships = repo<OrgMembershipEntity>(OrgMembershipEntity);
  const organizations = repo<OrganizationEntity>(OrganizationEntity);
  const departments = repo<DepartmentEntity>(DepartmentEntity);
  const roles = repo<RoleEntity>(RoleEntity);
  const sessions = repo<SessionEntity>(SessionEntity);
  const revokedTokens = repo<RevokedTokenEntity>(RevokedTokenEntity);
  const platformTerms = repo<PlatformTermsEntity>(PlatformTermsEntity);

  const userIds = new Set<string>();
  const orgIds = new Set<string>();
  const termsIds = new Set<string>();
  // Terms are now single-active platform-wide: exactly one T&C gates every org,
  // and every org accepts THAT SAME document (as in production). Creating a new
  // T&C activates it and deactivates the previous, which would stale an already-
  // consented org — so the harness mints ONE shared active T&C and reuses it for
  // every org in the suite, instead of one per org.
  let sharedTermsId: string | null = null;

  const api = () => request(app.getHttpServer());

  const mintToken = async (email: string): Promise<string> => {
    await api()
      .post('/api/v1/auth/send-otp')
      .send({ email })
      .expect(200);
    const res = await api()
      .post('/api/v1/auth/verify-otp')
      .send({ email, otp: DEV_OTP })
      .expect(200);
    const token = res.body?.data?.accessToken;
    if (!token) {
      throw new Error(
        `mintToken: no accessToken for ${email} — body: ${JSON.stringify(
          res.body,
        )}`,
      );
    }
    return token;
  };

  const harness: OrgTestHarness = {
    app,
    users,
    memberships,
    organizations,
    departments,
    roles,
    sessions,
    revokedTokens,
    platformTerms,
    api,
    mintToken,
    trackUser: (id: string) => {
      if (id) userIds.add(id);
    },
    trackOrg: (id: string) => {
      if (id) orgIds.add(id);
    },
    trackTerms: (id: string) => {
      if (id) termsIds.add(id);
    },

    async createTerms(saToken: string, title = `Test Terms ${newObjectId()}`) {
      // Reuse the one shared active T&C so every org gates on (and accepts) the
      // same document — provisioning a second org must not stale the first.
      if (sharedTermsId) return sharedTermsId;
      const res = await api()
        .post('/api/v1/admin/terms')
        .set('Authorization', `Bearer ${saToken}`)
        .send({
          title,
          text: '<h2>Test Terms</h2><p>Please accept to continue.</p>',
        })
        .expect(201);
      const id = res.body.data.id;
      termsIds.add(id);
      sharedTermsId = id;
      return id;
    },

    async createSuperAdmin() {
      const email = randomEmail('sa');
      const saved = await users.save(
        users.create({
          email: email.toLowerCase(),
          password: 'pending-otp-' + newObjectId(),
          firstName: 'Platform',
          lastName: 'Admin',
          isActive: true,
          setupStage: 'complete',
          roles: ['super_admin'],
          isPlatformAdmin: true,
          organizations: [],
        }),
      );
      userIds.add(saved.id);
      const token = await mintToken(saved.email);
      return { id: saved.id, email: saved.email, token };
    },

    async provisionOrg(name = randomOrgName()) {
      const sa = await this.createSuperAdmin();
      // Org creation requires a T&C from the library — create one to assign.
      const termsId = await this.createTerms(sa.token);
      const ownerEmail = randomEmail('owner');
      const res = await api()
        .post('/api/v1/admin/organizations')
        .set('Authorization', `Bearer ${sa.token}`)
        .send({
          name,
          ownerEmail,
          ownerFirstName: 'Owner',
          ownerLastName: 'One',
          termsId,
        })
        .expect(201);
      const orgId = res.body.data.organization.id;
      const ownerId = res.body.data.owner.id;
      orgIds.add(orgId);
      userIds.add(ownerId);
      const ownerToken = await mintToken(ownerEmail);
      return {
        orgId,
        slug: res.body.data.organization.slug,
        ownerId,
        ownerEmail,
        ownerToken,
        saToken: sa.token,
        termsId,
      };
    },

    async acceptConsent(org: CreatedOrg) {
      await api()
        .post('/api/v1/consent/accept')
        .set('Authorization', `Bearer ${org.ownerToken}`)
        .expect(201);
    },

    async createOrg(name = randomOrgName()) {
      // Provisioned orgs are active-but-unconsented (gated out of /org/*). The
      // departments/roles/team/overview suites exercise the ACTIVE org-admin
      // surface, so accept the Terms consent here — the consent gate itself is
      // covered by the consent suite.
      const org = await this.provisionOrg(name);
      await this.acceptConsent(org);
      return org;
    },

    async createEmployeeMember(org: CreatedOrg) {
      const email = randomEmail('emp');
      const res = await api()
        .post('/api/v1/org/members')
        .set('Authorization', `Bearer ${org.ownerToken}`)
        .send({ email, role: 'employee', firstName: 'Emp', lastName: 'Loyee' })
        .expect(201);
      const userId = res.body.data.userId;
      userIds.add(userId);
      const token = await mintToken(email);
      return { email, userId, token };
    },

    async cleanup() {
      const uids = [...userIds];
      const oids = [...orgIds];
      // Child rows first; no hard FKs, but keep it tidy.
      if (oids.length) {
        await memberships
          .delete({ organizationId: In(oids) })
          .catch(() => undefined);
        await departments
          .delete({ organizationId: In(oids) })
          .catch(() => undefined);
        await roles.delete({ organizationId: In(oids) }).catch(() => undefined);
      }
      if (uids.length) {
        await memberships
          .delete({ userId: In(uids) })
          .catch(() => undefined);
        await sessions.delete({ userId: In(uids) }).catch(() => undefined);
        await revokedTokens
          .delete({ userId: In(uids) })
          .catch(() => undefined);
      }
      if (oids.length) {
        await organizations.delete({ id: In(oids) }).catch(() => undefined);
      }
      const tids = [...termsIds];
      if (tids.length) {
        await platformTerms.delete({ id: In(tids) }).catch(() => undefined);
      }
      if (uids.length) {
        await users.delete({ id: In(uids) }).catch(() => undefined);
      }
      await app.close();
    },
  };

  return harness;
}
