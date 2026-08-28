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

const feature = loadFeature('./onboarding-self-service.feature', {
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

  /** Org + member + an initiated onboarding; returns the seeded doc/task keys. */
  const orgWithOnboarding = async (): Promise<{
    o: CreatedOrg;
    member: Member;
    docKey: string;
    selfTaskKey: string;
    itTaskKey: string;
  }> => {
    const o = await h.createOrg();
    orgIds.add(o.orgId);
    const member = await h.createEmployeeMember(o);
    const created = await h
      .api()
      .post(`${API}/onboarding/lifecycle/initiate`)
      .set('Authorization', `Bearer ${o.ownerToken}`)
      .send({ membershipId: member.userId })
      .expect(201);
    const data = created.body.data;
    const selfTask = data.checklist.find(
      (c: any) => c.assignedTo === 'self' || ['welcome', 'documents', 'training'].includes(c.category),
    );
    const itTask = data.checklist.find(
      (c: any) => c.assignedTo === 'it' || c.category === 'it_setup',
    );
    return {
      o,
      member,
      docKey: data.documents[0].key,
      selfTaskKey: selfTask.key,
      itTaskKey: itTask.key,
    };
  };

  const mine = (member: Member) =>
    h.api()
      .get(`${API}/onboarding/me`)
      .set('Authorization', `Bearer ${member.token}`);

  test('a hire reads their onboarding', ({ given, when, then }) => {
    let member: Member;
    let res: request.Response;
    given('an organization with an onboarding for a hire', async () => {
      ({ member } = await orgWithOnboarding());
    });
    when('the hire reads their onboarding', async () => {
      res = await mine(member);
    });
    then('they see their documents and checklist', () => {
      expect(res.status).toBe(200);
      expect(res.body.data).toBeTruthy();
      expect(res.body.data.documents.length).toBeGreaterThan(0);
      expect(res.body.data.checklist.length).toBeGreaterThan(0);
    });
  });

  test('a hire uploads a document', ({ given, when, then }) => {
    let member: Member;
    let docKey: string;
    let res: request.Response;
    given('an organization with an onboarding for a hire', async () => {
      ({ member, docKey } = await orgWithOnboarding());
    });
    when('the hire uploads a file against a required document', async () => {
      res = await h
        .api()
        .post(`${API}/onboarding/me/documents/${docKey}/upload`)
        .set('Authorization', `Bearer ${member.token}`)
        .send({ fileId: newObjectId() });
    });
    then(
      'that document shows as uploaded and the onboarding is in progress',
      () => {
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe('in_progress');
        const slot = res.body.data.documents.find((d: any) => d.key === docKey);
        expect(slot.status).toBe('uploaded');
      },
    );
  });

  test('a hire completes a self-serviceable task', ({ given, when, then }) => {
    let member: Member;
    let selfTaskKey: string;
    let res: request.Response;
    given('an organization with an onboarding for a hire', async () => {
      ({ member, selfTaskKey } = await orgWithOnboarding());
    });
    when('the hire completes a welcome task', async () => {
      res = await h
        .api()
        .post(`${API}/onboarding/me/checklist/${selfTaskKey}/complete`)
        .set('Authorization', `Bearer ${member.token}`);
    });
    then('that task shows as done', () => {
      expect(res.status).toBe(200);
      const item = res.body.data.checklist.find(
        (c: any) => c.key === selfTaskKey,
      );
      expect(item.status).toBe('done');
    });
  });

  test('a hire cannot complete an IT task', ({ given, when, then }) => {
    let member: Member;
    let itTaskKey: string;
    let res: request.Response;
    given('an organization with an onboarding for a hire', async () => {
      ({ member, itTaskKey } = await orgWithOnboarding());
    });
    when('the hire tries to complete an IT-owned task', async () => {
      res = await h
        .api()
        .post(`${API}/onboarding/me/checklist/${itTaskKey}/complete`)
        .set('Authorization', `Bearer ${member.token}`);
    });
    then('the task completion is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  test('a member with no onboarding gets an empty result', ({
    given,
    when,
    then,
  }) => {
    let o: CreatedOrg;
    let member: Member;
    let res: request.Response;
    given('an organization with an employee member', async () => {
      o = await h.createOrg();
      orgIds.add(o.orgId);
      member = await h.createEmployeeMember(o);
    });
    when('the employee reads their onboarding', async () => {
      res = await mine(member);
    });
    then('the onboarding result is empty', () => {
      expect(res.status).toBe(200);
      expect(res.body.data).toBeNull();
    });
  });
});
