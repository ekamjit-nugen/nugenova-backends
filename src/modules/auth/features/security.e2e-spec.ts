import { defineFeature, loadFeature } from 'jest-cucumber';
import request from 'supertest';

import {
  bootTestApp,
  createUser,
  TestHarness,
  DEV_OTP,
} from './support/harness';
import { UserEntity } from '../entities/user.entity';

const feature = loadFeature('./security.feature', { loadRelativePath: true });

defineFeature(feature, (test) => {
  let h: TestHarness;
  beforeAll(async () => {
    h = await bootTestApp();
  });
  afterAll(async () => {
    await h.cleanup();
  });

  const api = () => request(h.app.getHttpServer());

  const loginFresh = async (): Promise<{
    user: UserEntity;
    accessToken: string;
    refreshToken: string;
  }> => {
    const user = await createUser(h, { setupStage: 'complete', isActive: true });
    const res = await api()
      .post('/api/v1/auth/verify-otp')
      .send({ email: user.email, otp: DEV_OTP });
    return {
      user,
      accessToken: res.body.data.accessToken,
      refreshToken: res.body.data.refreshToken,
    };
  };

  test('the current user is returned for a valid Bearer token', ({
    given,
    when,
    then,
  }) => {
    let user: UserEntity;
    let accessToken: string;
    let res: request.Response;

    given('a logged-in user without MFA', async () => {
      ({ user, accessToken } = await loginFresh());
    });
    when('they call GET /auth/me with their access token', async () => {
      res = await api()
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${accessToken}`);
    });
    then('the response is 200 and returns their email', () => {
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.email).toBe(user.email);
      expect(res.body.data.id).toBe(res.body.data._id);
    });
  });

  test('GET /auth/me without a token is unauthorized', ({ when, then }) => {
    let res: request.Response;
    when('GET /auth/me is called with no token', async () => {
      res = await api().get('/api/v1/auth/me');
    });
    then('the response is 401', () => {
      expect(res.status).toBe(401);
    });
  });

  test('GET /auth/me with a garbage token is unauthorized', ({ when, then }) => {
    let res: request.Response;
    when('GET /auth/me is called with an invalid token', async () => {
      res = await api()
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer not-a-real-jwt');
    });
    then('the response is 401', () => {
      expect(res.status).toBe(401);
    });
  });

  test('refreshing rotates to a new pair of tokens', ({ given, when, then }) => {
    let refreshToken: string;
    let accessToken: string;
    let res: request.Response;

    given('a logged-in user without MFA', async () => {
      ({ accessToken, refreshToken } = await loginFresh());
    });
    when('they refresh with their refresh token', async () => {
      res = await api().post('/api/v1/auth/refresh').send({ refreshToken });
    });
    then(
      'the response is 200 and returns a new access and refresh token',
      () => {
        expect(res.status).toBe(200);
        expect(res.body.data.accessToken).toEqual(expect.any(String));
        expect(res.body.data.refreshToken).toEqual(expect.any(String));
        expect(res.body.data.refreshToken).not.toBe(refreshToken);
        expect(res.body.data.accessToken).not.toBe(accessToken);
      },
    );
  });

  test('reusing a refresh token after rotation is rejected', ({
    given,
    when,
    then,
  }) => {
    let refreshToken: string;
    let secondRes: request.Response;

    given('a logged-in user without MFA', async () => {
      ({ refreshToken } = await loginFresh());
    });
    when('they refresh with their refresh token', async () => {
      const first = await api()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken });
      expect(first.status).toBe(200);
    });
    when('they refresh again with the same original refresh token', async () => {
      secondRes = await api()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken });
    });
    then('the response is 401', () => {
      expect(secondRes.status).toBe(401);
    });
  });

  test('a logged-out access token can no longer authenticate', ({
    given,
    when,
    then,
  }) => {
    let accessToken: string;
    let meRes: request.Response;

    given('a logged-in user without MFA', async () => {
      ({ accessToken } = await loginFresh());
    });
    when('they log out with their access token', async () => {
      const logout = await api()
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`);
      expect(logout.status).toBe(200);
    });
    when('they call GET /auth/me with that same access token', async () => {
      meRes = await api()
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${accessToken}`);
    });
    then('the response is 401', () => {
      expect(meRes.status).toBe(401);
    });
  });
});
