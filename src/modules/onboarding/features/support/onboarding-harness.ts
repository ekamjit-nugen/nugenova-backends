import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
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
import { OrganizationEntity } from '../../../organization/entities/organization.entity';
import { OnboardingDocumentRequestEntity } from '../../entities/onboarding-document-request.entity';
import { OnboardingDocumentTemplateEntity } from '../../entities/onboarding-document-template.entity';
import { EmailOutboxEntity } from '../../../../bootstrap/mail/email-outbox.entity';
import { DocumentFileEntity } from '../../../../bootstrap/storage/document-file.entity';
import { newObjectId } from '../../../../bootstrap/database/object-id';

export const DEV_OTP = process.env.DEV_OTP_CODE || '000000';

export function randomEmail(prefix = 'onb'): string {
  return `${prefix}+${newObjectId()}@nugenova.test`;
}
export function randomOrgName(prefix = 'Onboard'): string {
  return `${prefix} ${newObjectId()}`;
}

export interface OnboardingOrg {
  orgId: string;
  slug: string;
  ownerId: string;
  ownerEmail: string;
  ownerToken: string; // routes to /onboarding
  saToken: string;
}

export interface OnboardingHarness {
  app: INestApplication;
  requests: Repository<OnboardingDocumentRequestEntity>;
  templates: Repository<OnboardingDocumentTemplateEntity>;
  outbox: Repository<EmailOutboxEntity>;
  files: Repository<DocumentFileEntity>;
  organizations: Repository<OrganizationEntity>;
  users: Repository<UserEntity>;
  memberships: Repository<OrgMembershipEntity>;

  api(): ReturnType<typeof request>;
  mintToken(email: string): Promise<string>;
  createSuperAdmin(): Promise<{ id: string; email: string; token: string }>;
  /** Provision an org (stays `onboarding`) + return an owner token routed there. */
  createOnboardingOrg(name?: string): Promise<OnboardingOrg>;
  /** Super admin requests documents for an org. Returns the created list. */
  requestDocs(
    org: OnboardingOrg,
    body: {
      templateKeys?: string[];
      customDocuments?: any[];
      notify?: boolean;
    },
  ): Promise<any[]>;

  trackUser(id: string): void;
  trackOrg(id: string): void;
  cleanup(): Promise<void>;
}

export async function bootOnboardingApp(): Promise<OnboardingHarness> {
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

  const requests = repo<OnboardingDocumentRequestEntity>(
    OnboardingDocumentRequestEntity,
  );
  const templates = repo<OnboardingDocumentTemplateEntity>(
    OnboardingDocumentTemplateEntity,
  );
  const outbox = repo<EmailOutboxEntity>(EmailOutboxEntity);
  const files = repo<DocumentFileEntity>(DocumentFileEntity);
  const organizations = repo<OrganizationEntity>(OrganizationEntity);
  const users = repo<UserEntity>(UserEntity);
  const memberships = repo<OrgMembershipEntity>(OrgMembershipEntity);
  const sessions = repo<SessionEntity>(SessionEntity);
  const revokedTokens = repo<RevokedTokenEntity>(RevokedTokenEntity);

  const userIds = new Set<string>();
  const orgIds = new Set<string>();

  const api = () => request(app.getHttpServer());

  const mintToken = async (email: string): Promise<string> => {
    await api().post('/api/v1/auth/send-otp').send({ email }).expect(200);
    const res = await api()
      .post('/api/v1/auth/verify-otp')
      .send({ email, otp: DEV_OTP })
      .expect(200);
    const token = res.body?.data?.accessToken;
    if (!token) {
      throw new Error(`mintToken: no accessToken for ${email}`);
    }
    return token;
  };

  const harness: OnboardingHarness = {
    app,
    requests,
    templates,
    outbox,
    files,
    organizations,
    users,
    memberships,
    api,
    mintToken,
    trackUser: (id) => id && userIds.add(id),
    trackOrg: (id) => id && orgIds.add(id),

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

    async createOnboardingOrg(name = randomOrgName()) {
      const sa = await this.createSuperAdmin();
      const ownerEmail = randomEmail('owner');
      const res = await api()
        .post('/api/v1/admin/organizations')
        .set('Authorization', `Bearer ${sa.token}`)
        .send({ name, ownerEmail, ownerFirstName: 'Owner', ownerLastName: 'One' })
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
      };
    },

    async requestDocs(org, body) {
      const res = await api()
        .post(`/api/v1/admin/organizations/${org.orgId}/documents`)
        .set('Authorization', `Bearer ${org.saToken}`)
        .send(body)
        .expect(201);
      return res.body.data.created as any[];
    },

    async cleanup() {
      const uids = [...userIds];
      const oids = [...orgIds];
      if (oids.length) {
        await requests
          .delete({ organizationId: In(oids) })
          .catch(() => undefined);
        await files.delete({ organizationId: In(oids) }).catch(() => undefined);
        await outbox
          .delete({ organizationId: In(oids) })
          .catch(() => undefined);
        await memberships
          .delete({ organizationId: In(oids) })
          .catch(() => undefined);
      }
      if (uids.length) {
        await memberships.delete({ userId: In(uids) }).catch(() => undefined);
        await sessions.delete({ userId: In(uids) }).catch(() => undefined);
        await revokedTokens
          .delete({ userId: In(uids) })
          .catch(() => undefined);
      }
      if (oids.length) {
        await organizations.delete({ id: In(oids) }).catch(() => undefined);
      }
      if (uids.length) {
        await users.delete({ id: In(uids) }).catch(() => undefined);
      }
      await app.close();
    },
  };

  return harness;
}
