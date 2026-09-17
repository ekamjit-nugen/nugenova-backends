import { defineFeature, loadFeature } from 'jest-cucumber';
import request from 'supertest';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { bootTestApp, createUser, TestHarness, DEV_OTP } from './support/harness';
import { UserEntity } from '../entities/user.entity';

const feature = loadFeature('./dashboard-layout.feature', { loadRelativePath: true });
const PATH = '/api/v1/auth/me/dashboard-layout';

defineFeature(feature, (test) => {
  let h: TestHarness;
  let users: Repository<UserEntity>;
  beforeAll(async () => {
    h = await bootTestApp();
    users = h.app.get(getRepositoryToken(UserEntity));
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
  const save = (token: string, body: unknown) => api().put(PATH).set('Authorization', `Bearer ${token}`).send(body as object);
  const read = (token: string) => api().get(PATH).set('Authorization', `Bearer ${token}`);

  test('a user saves their dashboard arrangement', ({ given, when, then }) => {
    let token: string;
    given('a signed-in user', async () => {
      ({ token } = await login());
      // Nothing saved yet: an empty arrangement, so the dashboard uses its default order.
      expect((await read(token).expect(200)).body.data).toEqual({ order: [], hidden: [] });
    });
    when('they move sales to the top and hide hiring', async () => {
      await save(token, { order: ['sales', 'attention', 'team-today', 'hiring'], hidden: ['hiring'] }).expect(200);
    });
    then('their dashboard layout comes back in that order with hiring hidden', async () => {
      const res = await read(token).expect(200);
      expect(res.body.data).toEqual({ order: ['sales', 'attention', 'team-today', 'hiring'], hidden: ['hiring'] });
    });
  });

  test('saving the dashboard keeps their other preferences', ({ given, when, then }) => {
    let token: string;
    let userId: string;
    given('a signed-in user who has set a chat holiday', async () => {
      const { user, token: t } = await login();
      token = t;
      userId = user.id;
      await users.update({ id: userId }, { preferences: { chatHoliday: { from: '2026-09-20', until: '2026-09-25' } } });
    });
    when('they save a dashboard layout', async () => {
      await save(token, { order: ['attention'], hidden: [] }).expect(200);
    });
    then('the chat holiday is still set', async () => {
      const user = await users.findOneByOrFail({ id: userId });
      expect(user.preferences).toEqual({
        chatHoliday: { from: '2026-09-20', until: '2026-09-25' },
        dashboard: { order: ['attention'], hidden: [] },
      });
    });
  });

  test('a malformed layout is refused', ({ given, when, then }) => {
    let token: string;
    let res: request.Response;
    given('a signed-in user', async () => {
      ({ token } = await login());
    });
    when('they save a layout whose order is not a list', async () => {
      res = await save(token, { order: 'sales' });
    });
    then('the request is rejected', () => {
      expect(res.status).toBe(400);
    });
  });

  test('the dashboard layout needs a signed-in user', ({ when, then }) => {
    let res: request.Response;
    when('someone without a token reads the dashboard layout', async () => {
      res = await api().get(PATH);
    });
    then('the request is unauthorized', () => {
      expect(res.status).toBe(401);
    });
  });
});
