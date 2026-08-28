import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import request from 'supertest';

import {
  bootOrgTestApp,
  OrgTestHarness,
  CreatedOrg,
} from '../../organization/features/support/org-harness';
import { newObjectId } from '../../../bootstrap/database/object-id';
import { MemberOnboardingEntity } from '../entities/member-onboarding.entity';
import { PolicyEntity } from '../../policy/entities/policy.entity';

const feature = loadFeature('./onboarding-lifecycle.feature', {
  loadRelativePath: true,
});
const API = '/api/v1';

interface Member {
  email: string;
  userId: string;
  token: string;
}

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let onboardings: Repository<MemberOnboardingEntity>;
  let policies: Repository<PolicyEntity>;
  const orgIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    onboardings = h.app.get(getRepositoryToken(MemberOnboardingEntity));
    policies = h.app.get(getRepositoryToken(PolicyEntity));
  });
  afterAll(async () => {
    const ids = [...orgIds];
    if (ids.length) {
      await onboardings.delete({ organizationId: In(ids) }).catch(() => undefined);
      await policies.delete({ organizationId: In(ids) }).catch(() => undefined);
    }
    await h.cleanup();
  });

  const orgWithMember = async (): Promise<{ o: CreatedOrg; member: Member }> => {
    const o = await h.createOrg();
    orgIds.add(o.orgId);
    const member = await h.createEmployeeMember(o);
    return { o, member };
  };

  const initiate = (o: CreatedOrg, membershipId: string, body: any = {}) =>
    h.api()
      .post(`${API}/onboarding/lifecycle/initiate`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
      .send({ membershipId, ...body });

  const list = (o: CreatedOrg, token = o.ownerToken) =>
    h.api()
      .get(`${API}/onboarding/lifecycle`)
      .set('Authorization', `Bearer ${token}`);

  const uploadAsMember = (member: Member, key: string) =>
    h.api()
      .post(`${API}/onboarding/me/documents/${key}/upload`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ fileId: newObjectId() });

  test('HR initiates onboarding for a member', ({ given, when, then, and }) => {
    let o: CreatedOrg;
    let member: Member;
    let res: request.Response;
    given('an organization with an employee member', async () => {
      ({ o, member } = await orgWithMember());
    });
    when('the owner initiates onboarding for that member', async () => {
      res = await initiate(o, member.userId);
    });
    then(
      'an onboarding is created seeded with documents and a checklist',
      () => {
        expect(res.status).toBe(201);
        expect(res.body.data.documents.length).toBeGreaterThan(0);
        expect(res.body.data.checklist.length).toBeGreaterThan(0);
        expect(res.body.data.status).toBe('pending');
      },
    );
    and('the member appears in the active onboarding list', async () => {
      const l = await list(o);
      const ids = l.body.data.map((r: any) => r.userId);
      expect(ids).toContain(member.userId);
    });
  });

  test('a second onboarding for the same member is blocked', ({
    given,
    and,
    when,
    then,
  }) => {
    let o: CreatedOrg;
    let member: Member;
    let res: request.Response;
    given('an organization with an employee member', async () => {
      ({ o, member } = await orgWithMember());
    });
    and('the owner has initiated onboarding for that member', async () => {
      await initiate(o, member.userId).expect(201);
    });
    when('the owner initiates onboarding for that member again', async () => {
      res = await initiate(o, member.userId);
    });
    then('the second initiate is rejected as a bad request', () => {
      expect(res.status).toBe(400);
    });
  });

  test('HR verifies an uploaded document', ({ given, when, then }) => {
    let o: CreatedOrg;
    let id: string;
    let key: string;
    let res: request.Response;
    given(
      'an organization with an onboarding whose member has uploaded a document',
      async () => {
        const { o: org, member } = await orgWithMember();
        o = org;
        const created = await initiate(o, member.userId).expect(201);
        id = created.body.data.id;
        key = created.body.data.documents[0].key;
        await uploadAsMember(member, key).expect(200);
      },
    );
    when('the owner verifies that document', async () => {
      res = await h
        .api()
        .post(`${API}/onboarding/lifecycle/${id}/documents/${key}/verify`)
        .set('Authorization', `Bearer ${o.ownerToken}`);
    });
    then('the document is marked verified', () => {
      expect(res.status).toBe(200);
      const slot = res.body.data.documents.find((d: any) => d.key === key);
      expect(slot.status).toBe('verified');
    });
  });

  test('HR rejects an uploaded document with a note', ({
    given,
    when,
    then,
  }) => {
    let o: CreatedOrg;
    let id: string;
    let key: string;
    let res: request.Response;
    given(
      'an organization with an onboarding whose member has uploaded a document',
      async () => {
        const { o: org, member } = await orgWithMember();
        o = org;
        const created = await initiate(o, member.userId).expect(201);
        id = created.body.data.id;
        key = created.body.data.documents[0].key;
        await uploadAsMember(member, key).expect(200);
      },
    );
    when('the owner rejects that document with a note', async () => {
      res = await h
        .api()
        .post(`${API}/onboarding/lifecycle/${id}/documents/${key}/reject`)
        .set('Authorization', `Bearer ${o.ownerToken}`)
        .send({ note: 'Blurry scan — please re-upload' });
    });
    then('the document is marked rejected with the note', () => {
      expect(res.status).toBe(200);
      const slot = res.body.data.documents.find((d: any) => d.key === key);
      expect(slot.status).toBe('rejected');
      expect(slot.note).toContain('Blurry');
    });
  });

  test('a policy edit reconciles onto an in-progress onboarding', ({
    given,
    and,
    when,
    then,
  }) => {
    let o: CreatedOrg;
    let member: Member;
    let id: string;
    let readRes: request.Response;
    given('an organization with an employee member', async () => {
      ({ o, member } = await orgWithMember());
    });
    and('the owner has initiated onboarding for that member', async () => {
      const created = await initiate(o, member.userId).expect(201);
      id = created.body.data.id;
    });
    when('the owner adds a passport to the onboarding requirements', async () => {
      // Read current config, append the passport, save it back.
      const cfg = await h
        .api()
        .get(`${API}/policies/onboarding-config`)
        .set('Authorization', `Bearer ${o.ownerToken}`)
        .expect(200);
      const docs = [
        ...cfg.body.data.documents,
        { key: 'passport', title: 'Passport', required: true },
      ];
      await h
        .api()
        .put(`${API}/policies/onboarding-config`)
        .set('Authorization', `Bearer ${o.ownerToken}`)
        .send({ documents: docs })
        .expect(200);
    });
    and('the owner reads that onboarding', async () => {
      readRes = await h
        .api()
        .get(`${API}/onboarding/lifecycle/${id}`)
        .set('Authorization', `Bearer ${o.ownerToken}`);
    });
    then('the onboarding now includes a pending passport document', () => {
      expect(readRes.status).toBe(200);
      const slot = readRes.body.data.documents.find(
        (d: any) => d.key === 'passport',
      );
      expect(slot).toBeTruthy();
      expect(slot.status).toBe('pending');
    });
  });

  test('HR completes an onboarding', ({ given, and, when, then }) => {
    let o: CreatedOrg;
    let member: Member;
    let id: string;
    let res: request.Response;
    given('an organization with an employee member', async () => {
      ({ o, member } = await orgWithMember());
    });
    and('the owner has initiated onboarding for that member', async () => {
      const created = await initiate(o, member.userId).expect(201);
      id = created.body.data.id;
    });
    when('the owner completes that onboarding', async () => {
      res = await h
        .api()
        .post(`${API}/onboarding/lifecycle/${id}/complete`)
        .set('Authorization', `Bearer ${o.ownerToken}`);
    });
    then('the onboarding status is completed', () => {
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('completed');
    });
    and('re-initiating onboarding for that member is blocked', async () => {
      const again = await initiate(o, member.userId);
      expect(again.status).toBe(400);
    });
  });

  test('an employee cannot read the onboarding list', ({
    given,
    when,
    then,
  }) => {
    let o: CreatedOrg;
    let member: Member;
    let res: request.Response;
    given('an organization with an employee member', async () => {
      ({ o, member } = await orgWithMember());
    });
    when('the employee requests the onboarding list', async () => {
      res = await list(o, member.token);
    });
    then('the onboarding list request is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  test('an HR role granting employees:edit can manage onboarding', ({
    given,
    when,
    then,
  }) => {
    let o: CreatedOrg;
    let hrToken: string;
    let res: request.Response;
    given(
      'an organization with a member whose custom role grants employees:edit',
      async () => {
        o = await h.createOrg();
        orgIds.add(o.orgId);
        const role = await h
          .api()
          .post(`${API}/org/roles`)
          .set('Authorization', `Bearer ${o.ownerToken}`)
          .send({
            name: 'HR Manager',
            permissions: [{ resource: 'employees', actions: ['view', 'create', 'edit'] }],
          })
          .expect(201);
        const email = `hr+${Date.now()}@nugenova.test`;
        const member = await h
          .api()
          .post(`${API}/org/members`)
          .set('Authorization', `Bearer ${o.ownerToken}`)
          .send({ email, roleId: role.body.data.id, firstName: 'Hr', lastName: 'Manager' })
          .expect(201);
        h.trackUser(member.body.data.userId);
        hrToken = await h.mintToken(email);
      },
    );
    when('that HR member requests the onboarding list', async () => {
      res = await list(o, hrToken);
    });
    then('the onboarding list is returned', () => {
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  test('filling in your profile auto-completes the profile checklist task', ({ given, when, then }) => {
    let o: CreatedOrg;
    let member: Member;
    given('an organization with an onboarding for a member', async () => {
      ({ o, member } = await orgWithMember());
      await initiate(o, member.userId).expect(201);
    });
    when('the member fills in their profile', async () => {
      await h
        .api()
        .put(`${API}/auth/me`)
        .set('Authorization', `Bearer ${member.token}`)
        .send({ firstName: 'Emp', lastName: 'Loyee', jobTitle: 'Engineer', phoneNumber: '+91 90000 00000' })
        .expect(200);
    });
    then('their "Complete your profile" task is done on the next read', async () => {
      const me = await h
        .api()
        .get(`${API}/onboarding/me`)
        .set('Authorization', `Bearer ${member.token}`)
        .expect(200);
      const task = (me.body.data.checklist as any[]).find((c) => c.key === 'profile_complete');
      expect(task?.status).toBe('done');
    });
  });

  test("the profile task follows the owner's required-fields configuration", ({
    given,
    and,
    when,
    then,
  }) => {
    let o: CreatedOrg;
    let member: Member;
    given('an organization that requires only the department profile field', async () => {
      o = await h.createOrg();
      orgIds.add(o.orgId);
      await h
        .api()
        .put(`${API}/policies/onboarding-config`)
        .set('Authorization', `Bearer ${o.ownerToken}`)
        .send({ profileFields: ['department'] })
        .expect(200);
    });
    and('an onboarding for a member of that org', async () => {
      member = await h.createEmployeeMember(o);
      await initiate(o, member.userId).expect(201);
    });
    when('the member fills in only their department', async () => {
      // No jobTitle/phone — only the configured field. Proves it's not hardcoded.
      await h
        .api()
        .put(`${API}/auth/me`)
        .set('Authorization', `Bearer ${member.token}`)
        .send({ firstName: 'Emp', lastName: 'Loyee', department: 'Engineering' })
        .expect(200);
    });
    then('their "Complete your profile" task is done on the next read', async () => {
      const me = await h
        .api()
        .get(`${API}/onboarding/me`)
        .set('Authorization', `Bearer ${member.token}`)
        .expect(200);
      const task = (me.body.data.checklist as any[]).find((c) => c.key === 'profile_complete');
      expect(task?.status).toBe('done');
    });
  });
});
