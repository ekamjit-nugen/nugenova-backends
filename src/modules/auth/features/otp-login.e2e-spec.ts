import { defineFeature, loadFeature } from 'jest-cucumber';
import request from 'supertest';

import {
  bootTestApp,
  createUser,
  randomEmail,
  TestHarness,
  DEV_OTP,
} from './support/harness';
import { UserEntity } from '../entities/user.entity';

const feature = loadFeature('./otp-login.feature', { loadRelativePath: true });

defineFeature(feature, (test) => {
  let h: TestHarness;
  beforeAll(async () => {
    h = await bootTestApp();
  });
  afterAll(async () => {
    await h.cleanup();
  });

  const api = () => request(h.app.getHttpServer());

  test('send-otp reports success for a known account', ({
    given,
    when,
    then,
  }) => {
    let user: UserEntity;
    let res: request.Response;

    given('an existing active user', async () => {
      user = await createUser(h, { isActive: true });
    });
    when('they request an OTP for their email', async () => {
      res = await api().post('/api/v1/auth/send-otp').send({ email: user.email });
    });
    then('the response is 200 and reports success', () => {
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
      expect(typeof res.body.message).toBe('string');
    });
  });

  test('send-otp rejects an email with no account', ({ when, then, and }) => {
    let res: request.Response;
    const email = randomEmail('nobody');

    when('an OTP is requested for an email that has no account', async () => {
      res = await api().post('/api/v1/auth/send-otp').send({ email });
    });
    then('the response is 404 with error code "NO_ACCOUNT"', () => {
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NO_ACCOUNT');
    });
    and('no account is created for that email', async () => {
      const created = await h.users.findOne({ where: { email } });
      expect(created).toBeNull();
    });
  });

  test("an invited user's first sign-in is flagged as a new user", ({
    given,
    when,
    then,
    and,
  }) => {
    let email: string;
    let res: request.Response;

    given('an invited user who has never logged in', async () => {
      const user = await createUser(h, { isActive: false, setupStage: 'invited' });
      email = user.email;
    });
    when(
      'they request an OTP and verify the dev-bypass code',
      async () => {
        await api().post('/api/v1/auth/send-otp').send({ email });
        res = await api()
          .post('/api/v1/auth/verify-otp')
          .send({ email, otp: DEV_OTP });
      },
    );
    then(
      'the response is 200 with an access token, a refresh token and the user',
      () => {
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.accessToken).toEqual(expect.any(String));
        expect(res.body.data.refreshToken).toEqual(expect.any(String));
        expect(res.body.data.user.email).toBe(email);
        expect(res.body.data.user.id).toBe(res.body.data.user._id);
      },
    );
    and('the response flags the account as a new user', () => {
      expect(res.body.data.isNewUser).toBe(true);
    });
  });

  test('a wrong code for a user with a live stored OTP is rejected', ({
    given,
    when,
    then,
  }) => {
    let user: UserEntity;
    let res: request.Response;

    given('an existing active user who has an OTP on file', async () => {
      user = await createUser(h, { isActive: true });
      // Populate a real stored OTP via the send-otp path.
      await api().post('/api/v1/auth/send-otp').send({ email: user.email });
    });
    when('they verify with the wrong six-digit code', async () => {
      // NOT the dev-bypass code, so the real bcrypt comparison runs and fails.
      res = await api()
        .post('/api/v1/auth/verify-otp')
        .send({ email: user.email, otp: '123456' });
    });
    then('the response is 400 with error code "INVALID_OTP"', () => {
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_OTP');
    });
  });

  test('verifying an unknown email returns the generic INVALID_OTP, not 404', ({
    when,
    then,
  }) => {
    let res: request.Response;

    when('an unknown email is verified with any six-digit code', async () => {
      // Even the dev-bypass code must not reveal that the account is absent.
      res = await api()
        .post('/api/v1/auth/verify-otp')
        .send({ email: randomEmail('ghost'), otp: DEV_OTP });
    });
    then('the response is 400 with error code "INVALID_OTP"', () => {
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_OTP');
    });
  });
});
