import { defineFeature, loadFeature } from 'jest-cucumber';
import request from 'supertest';

import {
  bootTestApp,
  createUser,
  newBase32Secret,
  totpFor,
  TestHarness,
  DEV_OTP,
} from './support/harness';
import { UserEntity } from '../entities/user.entity';

const feature = loadFeature('./mfa.feature', { loadRelativePath: true });

defineFeature(feature, (test) => {
  let h: TestHarness;
  beforeAll(async () => {
    h = await bootTestApp();
  });
  afterAll(async () => {
    await h.cleanup();
  });

  const api = () => request(h.app.getHttpServer());

  const loginFresh = async (): Promise<{ user: UserEntity; accessToken: string }> => {
    const user = await createUser(h, {
      setupStage: 'complete',
      isActive: true,
      mfaEnabled: false,
    });
    const res = await api()
      .post('/api/v1/auth/verify-otp')
      .send({ email: user.email, otp: DEV_OTP });
    return { user, accessToken: res.body.data.accessToken };
  };

  test('enrolling an authenticator returns a secret then backup codes', ({
    given,
    when,
    then,
  }) => {
    let accessToken: string;
    let secret: string;
    let setupRes: request.Response;
    let verifyRes: request.Response;

    given('a logged-in user without MFA', async () => {
      ({ accessToken } = await loginFresh());
    });
    when('they start MFA setup', async () => {
      setupRes = await api()
        .post('/api/v1/auth/mfa/setup')
        .set('Authorization', `Bearer ${accessToken}`);
      secret = setupRes.body.data.secret;
    });
    then('the response returns a secret and an otpauth URL', () => {
      expect(setupRes.status).toBe(200);
      expect(secret).toEqual(expect.any(String));
      expect(setupRes.body.data.otpauthUrl).toContain('otpauth://');
    });
    when('they verify MFA with a code generated from that secret', async () => {
      verifyRes = await api()
        .post('/api/v1/auth/mfa/verify')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ code: totpFor(secret) });
    });
    then('the response returns exactly 10 backup codes', () => {
      expect(verifyRes.status).toBe(200);
      expect(Array.isArray(verifyRes.body.data.backupCodes)).toBe(true);
      expect(verifyRes.body.data.backupCodes).toHaveLength(10);
    });
  });

  test('login for an MFA-enabled user returns a challenge instead of tokens', ({
    given,
    when,
    then,
    and,
  }) => {
    let user: UserEntity;
    let res: request.Response;

    given('an MFA-enabled user', async () => {
      user = await createUser(h, {
        setupStage: 'complete',
        isActive: true,
        mfaEnabled: true,
        mfaMethod: 'totp',
        mfaSecret: newBase32Secret(),
      });
    });
    when('they complete OTP verification', async () => {
      res = await api()
        .post('/api/v1/auth/verify-otp')
        .send({ email: user.email, otp: DEV_OTP });
    });
    then(
      'the response signals that MFA is required with a challenge token',
      () => {
        expect(res.status).toBe(200);
        expect(res.body.data.mfaRequired).toBe(true);
        expect(res.body.data.mfaChallengeToken).toEqual(expect.any(String));
        expect(res.body.data.email).toBe(user.email);
      },
    );
    and('no access token is issued', () => {
      expect(res.body.data.accessToken).toBeUndefined();
    });
  });

  test('completing the second factor finishes the login', ({
    given,
    when,
    then,
    and,
  }) => {
    let user: UserEntity;
    let secret: string;
    let challengeToken: string;
    let res: request.Response;

    given('an MFA-enabled user', async () => {
      secret = newBase32Secret();
      user = await createUser(h, {
        setupStage: 'complete',
        isActive: true,
        mfaEnabled: true,
        mfaMethod: 'totp',
        mfaSecret: secret,
      });
    });
    when('they complete OTP verification', async () => {
      const otpRes = await api()
        .post('/api/v1/auth/verify-otp')
        .send({ email: user.email, otp: DEV_OTP });
      challengeToken = otpRes.body.data.mfaChallengeToken;
    });
    and('they answer the MFA challenge with a valid TOTP code', async () => {
      res = await api()
        .post('/api/v1/auth/mfa/authenticate')
        .send({ mfaChallengeToken: challengeToken, code: totpFor(secret) });
    });
    then(
      'the response is 200 with an access token, a refresh token and the user',
      () => {
        expect(res.status).toBe(200);
        expect(res.body.data.accessToken).toEqual(expect.any(String));
        expect(res.body.data.refreshToken).toEqual(expect.any(String));
        expect(res.body.data.user.email).toBe(user.email);
      },
    );
  });

  test('a wrong TOTP code fails the second factor', ({
    given,
    when,
    then,
    and,
  }) => {
    let user: UserEntity;
    let challengeToken: string;
    let res: request.Response;

    given('an MFA-enabled user', async () => {
      user = await createUser(h, {
        setupStage: 'complete',
        isActive: true,
        mfaEnabled: true,
        mfaMethod: 'totp',
        mfaSecret: newBase32Secret(),
      });
    });
    when('they complete OTP verification', async () => {
      const otpRes = await api()
        .post('/api/v1/auth/verify-otp')
        .send({ email: user.email, otp: DEV_OTP });
      challengeToken = otpRes.body.data.mfaChallengeToken;
    });
    and('they answer the MFA challenge with an invalid code', async () => {
      res = await api()
        .post('/api/v1/auth/mfa/authenticate')
        .send({ mfaChallengeToken: challengeToken, code: '000000' });
    });
    then('the response is 401 with error code "MFA_INVALID"', () => {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('MFA_INVALID');
    });
  });
});
