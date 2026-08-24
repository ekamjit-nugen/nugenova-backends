import { defineFeature, loadFeature } from 'jest-cucumber';
import request from 'supertest';

import {
  bootOnboardingApp,
  OnboardingHarness,
  randomEmail,
} from './support/onboarding-harness';
import { newObjectId } from '../../../bootstrap/database/object-id';

const feature = loadFeature('./document-templates.feature', {
  loadRelativePath: true,
});

defineFeature(feature, (test) => {
  let h: OnboardingHarness;
  const createdTemplateIds: string[] = [];

  beforeAll(async () => {
    h = await bootOnboardingApp();
  });
  afterAll(async () => {
    // Custom templates are global (organizationId null) so clean them up by id.
    for (const id of createdTemplateIds) {
      await h.templates.delete({ id }).catch(() => undefined);
    }
    await h.cleanup();
  });

  const listTemplates = (token: string) =>
    h
      .api()
      .get('/api/v1/admin/document-templates')
      .set('Authorization', `Bearer ${token}`);

  test('the built-in document library is available to a super admin', ({
    given,
    when,
    then,
    and,
  }) => {
    let token: string;
    let res: request.Response;

    given('a signed-in super admin', async () => {
      token = (await h.createSuperAdmin()).token;
    });
    when('they list the document templates', async () => {
      res = await listTemplates(token);
    });
    then(
      'the built-in NDA and incorporation-certificate templates are present',
      () => {
        expect(res.status).toBe(200);
        const keys = res.body.data.map((t: any) => t.key);
        expect(keys).toContain('builtin_nda');
        expect(keys).toContain('builtin_incorporation_certificate');
      },
    );
    and('every built-in template is flagged as built-in', () => {
      const builtins = res.body.data.filter((t: any) => t.key);
      expect(builtins.length).toBeGreaterThan(0);
      expect(builtins.every((t: any) => t.isBuiltin === true)).toBe(true);
    });
  });

  test('a super admin creates a custom template', ({
    given,
    when,
    then,
    and,
  }) => {
    let token: string;
    let res: request.Response;

    given('a signed-in super admin', async () => {
      token = (await h.createSuperAdmin()).token;
    });
    when('they create a custom template that requires a signature', async () => {
      res = await h
        .api()
        .post('/api/v1/admin/document-templates')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: `Custom Consent ${newObjectId()}`,
          category: 'agreement',
          requiresSignature: true,
        });
      if (res.body?.data?.id) createdTemplateIds.push(res.body.data.id);
    });
    then('the custom template appears in the library', async () => {
      expect(res.status).toBe(201);
      const list = await listTemplates(token);
      const ids = list.body.data.map((t: any) => t.id);
      expect(ids).toContain(res.body.data.id);
    });
    and('it is not flagged as built-in', () => {
      expect(res.body.data.isBuiltin).toBe(false);
    });
  });

  test('a super admin deletes a custom template', ({ given, when, then }) => {
    let token: string;
    let templateId: string;

    given('a super admin has created a custom template', async () => {
      token = (await h.createSuperAdmin()).token;
      const res = await h
        .api()
        .post('/api/v1/admin/document-templates')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `Temp ${newObjectId()}`, requiresUpload: true });
      templateId = res.body.data.id;
      createdTemplateIds.push(templateId);
    });
    when('they delete that custom template', async () => {
      const res = await h
        .api()
        .delete(`/api/v1/admin/document-templates/${templateId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    });
    then('the custom template no longer appears in the library', async () => {
      const list = await listTemplates(token);
      const ids = list.body.data.map((t: any) => t.id);
      expect(ids).not.toContain(templateId);
    });
  });

  test('built-in templates cannot be deleted', ({ given, when, then }) => {
    let token: string;
    let res: request.Response;

    given('a signed-in super admin', async () => {
      token = (await h.createSuperAdmin()).token;
    });
    when('they try to delete a built-in template', async () => {
      const list = await listTemplates(token);
      const builtin = list.body.data.find((t: any) => t.key);
      res = await h
        .api()
        .delete(`/api/v1/admin/document-templates/${builtin.id}`)
        .set('Authorization', `Bearer ${token}`);
    });
    then('the deletion is rejected as not found', () => {
      expect(res.status).toBe(404);
    });
  });

  test('a non super admin cannot list document templates', ({
    given,
    when,
    then,
  }) => {
    let token: string;
    let res: request.Response;

    given('a signed-in ordinary user who is not a platform admin', async () => {
      const email = randomEmail('user');
      const u = await h.users.save(
        h.users.create({
          email: email.toLowerCase(),
          password: 'pending-otp-' + newObjectId(),
          firstName: 'Ordinary',
          lastName: 'User',
          isActive: true,
          setupStage: 'complete',
          roles: ['user'],
          isPlatformAdmin: false,
        }),
      );
      h.trackUser(u.id);
      token = await h.mintToken(u.email);
    });
    when('they try to list the document templates', async () => {
      res = await listTemplates(token);
    });
    then('the request is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });
});
