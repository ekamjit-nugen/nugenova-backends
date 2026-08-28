import { defineFeature, loadFeature } from 'jest-cucumber';
import request from 'supertest';

import { bootTestApp, createUser, TestHarness, DEV_OTP } from './support/harness';

const feature = loadFeature('./profile.feature', { loadRelativePath: true });

defineFeature(feature, (test) => {
  let h: TestHarness;
  beforeAll(async () => {
    h = await bootTestApp();
  });
  afterAll(async () => {
    await h.cleanup();
  });

  const api = () => request(h.app.getHttpServer());

  const login = async (overrides = {}) => {
    const user = await createUser(h, { setupStage: 'complete', isActive: true, ...overrides });
    const res = await api().post('/api/v1/auth/verify-otp').send({ email: user.email, otp: DEV_OTP });
    return { user, token: res.body.data.accessToken as string };
  };
  const put = (token: string, body: any) =>
    api().put('/api/v1/auth/me').set('Authorization', `Bearer ${token}`).send(body);
  const me = (token: string) =>
    api().get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);

  test('a user updates their profile', ({ given, when, then }) => {
    let token: string;
    let res: request.Response;
    given('a signed-in user', async () => {
      ({ token } = await login());
    });
    when('they update their profile with contact, role, bio and social details', async () => {
      res = await put(token, {
        firstName: 'Ada', lastName: 'Lovelace', phoneNumber: '+91 90000 00000',
        jobTitle: 'Engineer', department: 'R&D', bio: 'Builds things.',
        location: 'Bengaluru', timezone: 'Asia/Kolkata',
        linkedIn: 'linkedin.com/in/ada', github: 'github.com/ada',
      }).expect(200);
    });
    then('GET /auth/me returns the updated profile', async () => {
      const got = await me(token).expect(200);
      const d = got.body.data;
      expect(d.firstName).toBe('Ada');
      expect(d.jobTitle).toBe('Engineer');
      expect(d.department).toBe('R&D');
      expect(d.location).toBe('Bengaluru');
      expect(d.timezone).toBe('Asia/Kolkata');
      expect(d.linkedIn).toBe('linkedin.com/in/ada');
      expect(d.github).toBe('github.com/ada');
      expect(d.bio).toBe('Builds things.');
    });
  });

  test('a name cannot be blanked but other fields can be cleared', ({ given, when, then }) => {
    let token: string;
    given('a signed-in user with a full profile', async () => {
      ({ token } = await login({ firstName: 'Grace', lastName: 'Hopper' }));
      await put(token, { jobTitle: 'Admiral' }).expect(200);
    });
    when('they submit an empty first name and empty job title', async () => {
      await put(token, { firstName: '', jobTitle: '' }).expect(200);
    });
    then('the first name is kept and the job title is cleared', async () => {
      const got = await me(token).expect(200);
      expect(got.body.data.firstName).toBe('Grace');
      expect(got.body.data.jobTitle).toBeNull();
    });
  });
});
