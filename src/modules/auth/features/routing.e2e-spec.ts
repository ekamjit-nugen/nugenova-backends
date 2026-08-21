import { defineFeature, loadFeature } from 'jest-cucumber';
import request from 'supertest';

import {
  bootTestApp,
  createUser,
  createMembership,
  TestHarness,
  DEV_OTP,
} from './support/harness';
import { UserEntity } from '../entities/user.entity';
import { newObjectId } from '../../../bootstrap/database/object-id';

const feature = loadFeature('./routing.feature', { loadRelativePath: true });

defineFeature(feature, (test) => {
  let h: TestHarness;
  beforeAll(async () => {
    h = await bootTestApp();
  });
  afterAll(async () => {
    await h.cleanup();
  });

  const api = () => request(h.app.getHttpServer());

  const verify = (email: string) =>
    api().post('/api/v1/auth/verify-otp').send({ email, otp: DEV_OTP });

  test('a brand-new user with no memberships is sent to org setup', ({
    given,
    when,
    then,
  }) => {
    let user: UserEntity;
    let res: request.Response;

    given('a fresh email that has never logged in', async () => {
      // Mirror the send-otp-provisioned pending user: inactive + otp_verified.
      user = await createUser(h, {
        isActive: false,
        setupStage: 'otp_verified',
      });
    });
    when('they complete OTP verification', async () => {
      res = await verify(user.email);
    });
    then(
      'the route is "/auth/setup-organization" with reason "new_user"',
      () => {
        expect(res.status).toBe(200);
        expect(res.body.data.route).toBe('/auth/setup-organization');
        expect(res.body.data.routeReason).toBe('new_user');
      },
    );
  });

  test('a platform admin is sent to the platform console', ({
    given,
    when,
    then,
  }) => {
    let user: UserEntity;
    let res: request.Response;

    given('a platform-admin user', async () => {
      user = await createUser(h, {
        isPlatformAdmin: true,
        roles: ['super_admin'],
        setupStage: 'complete',
        isActive: true,
      });
    });
    when('they complete OTP verification', async () => {
      res = await verify(user.email);
    });
    then('the route is "/platform" with reason "platform_admin"', () => {
      expect(res.status).toBe(200);
      expect(res.body.data.route).toBe('/platform');
      expect(res.body.data.routeReason).toBe('platform_admin');
    });
  });

  test('a completed single-org user lands on the dashboard', ({
    given,
    when,
    then,
    and,
  }) => {
    let user: UserEntity;
    let orgId: string;
    let res: request.Response;

    given(
      'a completed user with one active organization membership',
      async () => {
        orgId = newObjectId();
        user = await createUser(h, { setupStage: 'complete', isActive: true });
        await createMembership(h, user.id, {
          organizationId: orgId,
          role: 'manager',
          status: 'active',
        });
      },
    );
    when('they complete OTP verification', async () => {
      res = await verify(user.email);
    });
    then('the route is "/dashboard" with reason "active_user"', () => {
      expect(res.status).toBe(200);
      expect(res.body.data.route).toBe('/dashboard');
      expect(res.body.data.routeReason).toBe('active_user');
    });
    and('the response carries that organization id', () => {
      expect(res.body.data.organizationId).toBe(orgId);
    });
  });

  test('a completed user with several active orgs picks one', ({
    given,
    when,
    then,
  }) => {
    let user: UserEntity;
    let res: request.Response;

    given(
      'a completed user with two active organization memberships',
      async () => {
        user = await createUser(h, { setupStage: 'complete', isActive: true });
        await createMembership(h, user.id, { status: 'active', role: 'manager' });
        await createMembership(h, user.id, { status: 'active', role: 'employee' });
      },
    );
    when('they complete OTP verification', async () => {
      res = await verify(user.email);
    });
    then(
      'the route is "/auth/select-organization" with reason "multi_org"',
      () => {
        expect(res.status).toBe(200);
        expect(res.body.data.route).toBe('/auth/select-organization');
        expect(res.body.data.routeReason).toBe('multi_org');
      },
    );
  });

  test('a pending invite wins routing over an active membership', ({
    given,
    when,
    then,
  }) => {
    let user: UserEntity;
    let res: request.Response;

    given(
      'a completed user with one active and one pending membership',
      async () => {
        user = await createUser(h, { setupStage: 'complete', isActive: true });
        await createMembership(h, user.id, { status: 'active', role: 'manager' });
        await createMembership(h, user.id, { status: 'pending', role: 'employee' });
      },
    );
    when('they complete OTP verification', async () => {
      res = await verify(user.email);
    });
    then(
      'the route is "/auth/accept-invite" with reason "pending_invite"',
      () => {
        expect(res.status).toBe(200);
        expect(res.body.data.route).toBe('/auth/accept-invite');
        expect(res.body.data.routeReason).toBe('pending_invite');
      },
    );
  });
});
