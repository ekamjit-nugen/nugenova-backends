import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import request from 'supertest';

import {
  bootOrgTestApp,
  OrgTestHarness,
  CreatedOrg,
  randomEmail,
} from '../../organization/features/support/org-harness';
import { PolicyEntity } from '../entities/policy.entity';
import { PolicyAcknowledgementEntity } from '../entities/policy-acknowledgement.entity';

const feature = loadFeature('./policy.feature', { loadRelativePath: true });
const API = '/api/v1';

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let policies: Repository<PolicyEntity>;
  let acks: Repository<PolicyAcknowledgementEntity>;
  const orgIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    policies = h.app.get(getRepositoryToken(PolicyEntity));
    acks = h.app.get(getRepositoryToken(PolicyAcknowledgementEntity));
  });
  afterAll(async () => {
    const ids = [...orgIds];
    if (ids.length) {
      await acks.delete({ organizationId: In(ids) }).catch(() => undefined);
      await policies.delete({ organizationId: In(ids) }).catch(() => undefined);
    }
    await h.cleanup();
  });

  const org = async () => {
    const o = await h.createOrg();
    orgIds.add(o.orgId);
    return o;
  };
  const create = (o: CreatedOrg, body: any, token = o.ownerToken) =>
    h.api().post(`${API}/policies`).set('Authorization', `Bearer ${token}`).send(body);
  const wt = (startTime = '10:00') => ({
    policyName: 'WT',
    category: 'working_hours',
    workTiming: { startTime, endTime: '18:00', timezone: 'Asia/Kolkata' },
  });

  test('a new organization is seeded with a default work-timing policy', ({ given, when, then }) => {
    let o: CreatedOrg;
    let res: request.Response;
    given('a freshly provisioned organization', async () => {
      o = await org();
    });
    when('its policies are listed', async () => {
      res = await h.api().get(`${API}/policies`).set('Authorization', `Bearer ${o.ownerToken}`);
    });
    then('a default work-timing policy applicable to everyone exists', () => {
      expect(res.status).toBe(200);
      const list = res.body.data as any[];
      const def = list.find(
        (p) => p.category === 'working_hours' && p.applicableTo === 'all' && p.workTiming?.startTime,
      );
      expect(def).toBeTruthy();
    });
  });

  test('an org admin creates a work-timing policy', ({ given, when, then }) => {
    let o: CreatedOrg;
    let res: request.Response;
    given('an organization', async () => {
      o = await org();
    });
    when(/^the owner creates a work-timing policy starting at "(.*)"$/, async (start) => {
      res = await create(o, wt(start));
    });
    then('the policy is created with that work timing', () => {
      expect(res.status).toBe(201);
      expect(res.body.data.workTiming.startTime).toBe('10:00');
    });
  });

  test("listing policies returns only the caller's organization", ({ given, when, then }) => {
    let a: CreatedOrg;
    let b: CreatedOrg;
    let res: request.Response;
    given('two organizations that each have policies', async () => {
      a = await org();
      b = await org();
      await create(a, wt('08:00')).expect(201);
      await create(b, wt('09:00')).expect(201);
    });
    when("the first organization's owner lists policies", async () => {
      res = await h.api().get(`${API}/policies`).set('Authorization', `Bearer ${a.ownerToken}`);
    });
    then("only the first organization's policies are returned", () => {
      expect(res.status).toBe(200);
      const orgs = new Set((res.body.data as any[]).map((p) => p.organizationId));
      expect([...orgs]).toEqual([a.orgId]);
    });
  });

  test('an employee can read policies but cannot create one', ({ given, when, then, but }) => {
    let o: CreatedOrg;
    let emp: { token: string };
    let res: request.Response;
    given('an organization with an employee', async () => {
      o = await org();
      emp = await h.createEmployeeMember(o);
    });
    when('the employee lists policies', async () => {
      res = await h.api().get(`${API}/policies`).set('Authorization', `Bearer ${emp.token}`);
    });
    then('the request succeeds', () => {
      expect(res.status).toBe(200);
    });
    but('when the employee tries to create a policy', async () => {
      res = await create(o, wt(), emp.token);
    });
    then('the request is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  test('a permission-scoped member with policies:create can create a policy', ({ given, when, then }) => {
    let o: CreatedOrg;
    let authorToken: string;
    let res: request.Response;
    given('an organization with a policy-author member', async () => {
      o = await org();
      const role = await h
        .api()
        .post(`${API}/org/roles`)
        .set('Authorization', `Bearer ${o.ownerToken}`)
        .send({
          name: 'policy_author',
          displayName: 'Policy Author',
          permissions: [{ resource: 'policies', actions: ['view', 'create', 'edit', 'delete'] }],
        })
        .expect(201);
      const email = randomEmail('author');
      const m = await h
        .api()
        .post(`${API}/org/members`)
        .set('Authorization', `Bearer ${o.ownerToken}`)
        .send({ email, roleId: role.body.data.id, firstName: 'Pol', lastName: 'Author' })
        .expect(201);
      h.trackUser(m.body.data.userId);
      authorToken = await h.mintToken(email);
    });
    when(/^the policy-author creates a work-timing policy starting at "(.*)"$/, async () => {
      res = await create(o, wt('09:30'), authorToken);
    });
    then('the policy is created with that work timing', () => {
      expect(res.status).toBe(201);
      expect(res.body.data.workTiming.startTime).toBe('09:30');
    });
  });

  test('a permission-scoped member without policies:create is denied', ({ given, when, then }) => {
    let o: CreatedOrg;
    let emp: { token: string };
    let res: request.Response;
    given('an organization with an employee', async () => {
      o = await org();
      emp = await h.createEmployeeMember(o);
    });
    when('the employee tries to create a policy', async () => {
      res = await create(o, wt(), emp.token);
    });
    then('the request is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  test("the platform super admin cannot read an organization's policies", ({ given, when, then }) => {
    let res: request.Response;
    given('an organization that has policies', async () => {
      const o = await org();
      await create(o, wt()).expect(201);
    });
    when("the platform super admin lists that organization's policies", async () => {
      const sa = await h.createSuperAdmin();
      res = await h.api().get(`${API}/policies`).set('Authorization', `Bearer ${sa.token}`);
    });
    then('the request is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  test('updating a policy bumps its version', ({ given, when, then }) => {
    let o: CreatedOrg;
    let id: string;
    let res: request.Response;
    given('an organization with a work-timing policy', async () => {
      o = await org();
      const c = await create(o, wt('09:00')).expect(201);
      id = c.body.data.id;
      expect(c.body.data.version).toBe(1);
    });
    when(/^the owner updates the policy start time to "(.*)"$/, async () => {
      res = await h
        .api()
        .put(`${API}/policies/${id}`)
        .set('Authorization', `Bearer ${o.ownerToken}`)
        .send({ workTiming: { startTime: '11:00', endTime: '18:00', timezone: 'Asia/Kolkata' } });
    });
    then('the policy version is incremented', () => {
      expect(res.status).toBe(200);
      expect(res.body.data.version).toBe(2);
      expect(res.body.data.workTiming.startTime).toBe('11:00');
    });
  });

  test('deleting a policy soft-deletes it', ({ given, when, then }) => {
    let o: CreatedOrg;
    let id: string;
    given('an organization with a work-timing policy', async () => {
      o = await org();
      const c = await create(o, wt()).expect(201);
      id = c.body.data.id;
    });
    when('the owner deletes the policy', async () => {
      await h
        .api()
        .delete(`${API}/policies/${id}`)
        .set('Authorization', `Bearer ${o.ownerToken}`)
        .expect(200);
    });
    then('the policy no longer appears in the list', async () => {
      const res = await h
        .api()
        .get(`${API}/policies`)
        .set('Authorization', `Bearer ${o.ownerToken}`)
        .expect(200);
      expect((res.body.data as any[]).some((p) => p.id === id)).toBe(false);
    });
  });

  test('an employee acknowledges a policy that requires acknowledgement', ({ given, and, when, then }) => {
    let o: CreatedOrg;
    let emp: { userId: string; token: string };
    let id: string;
    let res: request.Response;
    given('an organization with a policy that requires acknowledgement', async () => {
      o = await org();
      const c = await create(o, { ...wt(), acknowledgementRequired: true }).expect(201);
      id = c.body.data.id;
    });
    and('an employee who has not acknowledged it', async () => {
      emp = await h.createEmployeeMember(o);
    });
    when('the employee acknowledges the policy', async () => {
      res = await h
        .api()
        .post(`${API}/policies/${id}/acknowledge`)
        .set('Authorization', `Bearer ${emp.token}`)
        .send({});
    });
    then('the acknowledgement is recorded for that employee', async () => {
      expect(res.status).toBe(200);
      const row = await acks.findOne({ where: { policyId: id, employeeId: emp.userId } });
      expect(row).toBeTruthy();
      expect(row!.organizationId).toBe(o.orgId);
    });
  });

  test('an employee must accept an outstanding required policy before using the platform', ({
    given,
    and,
    when,
    then,
  }) => {
    let o: CreatedOrg;
    let emp: { userId: string; token: string };
    let id: string;
    let res: request.Response;
    given('an organization with an active required policy applicable to everyone', async () => {
      o = await org();
      const c = await create(o, {
        ...wt(),
        acknowledgementRequired: true,
        isActive: true,
        applicableTo: 'all',
      }).expect(201);
      id = c.body.data.id;
    });
    and('an employee who has not acknowledged it', async () => {
      emp = await h.createEmployeeMember(o);
    });
    when('the employee lists their pending acknowledgements', async () => {
      res = await h
        .api()
        .get(`${API}/policies/pending-acknowledgements`)
        .set('Authorization', `Bearer ${emp.token}`);
    });
    then('the required policy is listed as pending', () => {
      expect(res.status).toBe(200);
      const ids = (res.body.data as any[]).map((p) => p.id);
      expect(ids).toContain(id);
    });
    and('once the employee acknowledges it, nothing is pending', async () => {
      await h
        .api()
        .post(`${API}/policies/${id}/acknowledge`)
        .set('Authorization', `Bearer ${emp.token}`)
        .send({})
        .expect(200);
      const after = await h
        .api()
        .get(`${API}/policies/pending-acknowledgements`)
        .set('Authorization', `Bearer ${emp.token}`)
        .expect(200);
      expect((after.body.data as any[]).map((p) => p.id)).not.toContain(id);
    });
  });

  test('a newly created policy starts as a draft', ({ given, when, then }) => {
    let o: CreatedOrg;
    let res: request.Response;
    given('an organization', async () => {
      o = await org();
    });
    when('the owner creates a policy without specifying active', async () => {
      res = await create(o, wt());
    });
    then('the policy is inactive (a draft)', () => {
      expect(res.status).toBe(201);
      expect(res.body.data.isActive).toBe(false);
    });
  });

  test('activating a draft does not bump its version', ({ given, when, then }) => {
    let o: CreatedOrg;
    let id: string;
    let res: request.Response;
    given('an organization with a draft policy at version 1', async () => {
      o = await org();
      const c = await create(o, wt()).expect(201);
      id = c.body.data.id;
      expect(c.body.data.isActive).toBe(false);
      expect(c.body.data.version).toBe(1);
    });
    when('the owner activates the policy', async () => {
      res = await h
        .api()
        .put(`${API}/policies/${id}/active`)
        .set('Authorization', `Bearer ${o.ownerToken}`)
        .send({ isActive: true });
    });
    then('the policy is active and still at version 1', () => {
      expect(res.status).toBe(200);
      expect(res.body.data.isActive).toBe(true);
      expect(res.body.data.version).toBe(1);
    });
  });

  test('updating a policy records a version snapshot', ({ given, when, then }) => {
    let o: CreatedOrg;
    let id: string;
    given('an organization with a work-timing policy at version 1', async () => {
      o = await org();
      const c = await create(o, wt('09:00')).expect(201);
      id = c.body.data.id;
    });
    when(/^the owner updates the policy start time to "(.*)"$/, async () => {
      await h
        .api()
        .put(`${API}/policies/${id}`)
        .set('Authorization', `Bearer ${o.ownerToken}`)
        .send({ workTiming: { startTime: '11:00', endTime: '18:00', timezone: 'Asia/Kolkata' } })
        .expect(200);
    });
    then('a version 1 snapshot is kept in the policy history', async () => {
      const res = await h
        .api()
        .get(`${API}/policies/${id}/versions`)
        .set('Authorization', `Bearer ${o.ownerToken}`)
        .expect(200);
      const v1 = (res.body.data as any[]).find((v) => v.version === 1);
      expect(v1).toBeTruthy();
      expect(v1.snapshot.workTiming.startTime).toBe('09:00');
    });
  });

  test('the owner sees who has not acknowledged a required policy', ({ given, when, then }) => {
    let o: CreatedOrg;
    let emp: { userId: string };
    let id: string;
    let res: request.Response;
    given(
      'an organization with a required policy and an employee who has not acknowledged',
      async () => {
        o = await org();
        emp = await h.createEmployeeMember(o);
        const c = await create(o, { ...wt(), acknowledgementRequired: true, isActive: true }).expect(201);
        id = c.body.data.id;
      },
    );
    when('the owner views the acknowledgement status', async () => {
      res = await h
        .api()
        .get(`${API}/policies/${id}/acknowledgements`)
        .set('Authorization', `Bearer ${o.ownerToken}`);
    });
    then('the employee appears as pending', () => {
      expect(res.status).toBe(200);
      const pendingIds = (res.body.data.pending as any[]).map((p) => p.userId);
      expect(pendingIds).toContain(emp.userId);
    });
  });

  test('the owner sees org-wide acknowledgement compliance', ({ given, when, then, and }) => {
    let o: CreatedOrg;
    let acked: { userId: string; token: string };
    let pendingEmp: { userId: string };
    let id: string;
    let res: request.Response;
    given(
      'an organization with an active required policy and two employees, one of whom has acknowledged',
      async () => {
        o = await org();
        const c = await create(o, {
          ...wt(),
          acknowledgementRequired: true,
          isActive: true,
          applicableTo: 'all',
        }).expect(201);
        id = c.body.data.id;
        acked = await h.createEmployeeMember(o);
        pendingEmp = await h.createEmployeeMember(o);
        await h
          .api()
          .post(`${API}/policies/${id}/acknowledge`)
          .set('Authorization', `Bearer ${acked.token}`)
          .send({})
          .expect(200);
      },
    );
    when('the owner views the compliance overview', async () => {
      res = await h
        .api()
        .get(`${API}/policies/compliance`)
        .set('Authorization', `Bearer ${o.ownerToken}`);
    });
    then('the overview shows that policy with one acknowledged and one pending', () => {
      expect(res.status).toBe(200);
      const d = res.body.data;
      const policy = (d.perPolicy as any[]).find((p) => p.policyId === id);
      expect(policy).toBeDefined();
      expect(policy.pendingCount).toBe(1);
      expect(policy.ackedCount).toBe(1);
      expect(policy.coveragePct).toBe(50);
    });
    and('the outstanding person lists the unacknowledged policy', () => {
      const person = (res.body.data.people as any[]).find((p) => p.userId === pendingEmp.userId);
      expect(person).toBeDefined();
      expect((person.pending as any[]).map((x) => x.policyId)).toContain(id);
    });
  });

  test('reminding pending members notifies them', ({ given, when, then, and }) => {
    let o: CreatedOrg;
    let emp: { userId: string; token: string };
    let id: string;
    let res: request.Response;
    given(
      'an organization with an active required policy and an employee who has not acknowledged',
      async () => {
        o = await org();
        emp = await h.createEmployeeMember(o);
        const c = await create(o, {
          ...wt(),
          acknowledgementRequired: true,
          isActive: true,
          applicableTo: 'all',
        }).expect(201);
        id = c.body.data.id;
      },
    );
    when('the owner reminds members pending on that policy', async () => {
      res = await h
        .api()
        .post(`${API}/policies/${id}/remind`)
        .set('Authorization', `Bearer ${o.ownerToken}`)
        .send({});
    });
    then('one member is reminded', () => {
      expect(res.status).toBe(200);
      expect(res.body.data.reminded).toBe(1);
    });
    and('that employee has an in-app policy acknowledgement reminder', async () => {
      const inbox = await h
        .api()
        .get(`${API}/notifications`)
        .set('Authorization', `Bearer ${emp.token}`)
        .expect(200);
      const reminder = (inbox.body.items as any[]).find((n) => n.type === 'policy_ack_reminder');
      expect(reminder).toBeDefined();
      expect(reminder.data.actionUrl).toBe('/policies');
    });
  });

  test('an employee cannot remind members', ({ given, when, then }) => {
    let o: CreatedOrg;
    let emp: { userId: string; token: string };
    let id: string;
    let res: request.Response;
    given(
      'an organization with an active required policy and an employee who has not acknowledged',
      async () => {
        o = await org();
        emp = await h.createEmployeeMember(o);
        const c = await create(o, {
          ...wt(),
          acknowledgementRequired: true,
          isActive: true,
          applicableTo: 'all',
        }).expect(201);
        id = c.body.data.id;
      },
    );
    when('the employee tries to remind members pending on that policy', async () => {
      res = await h
        .api()
        .post(`${API}/policies/${id}/remind`)
        .set('Authorization', `Bearer ${emp.token}`)
        .send({});
    });
    then('the reminder request is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  test("the org owner is exempt from the org's own required policies", ({ given, when, then, and }) => {
    let o: CreatedOrg;
    let id: string;
    let res: request.Response;
    given('an organization with an active required policy applicable to everyone', async () => {
      o = await org();
      const c = await create(o, {
        ...wt(),
        acknowledgementRequired: true,
        isActive: true,
        applicableTo: 'all',
      }).expect(201);
      id = c.body.data.id;
    });
    when('the owner lists their pending acknowledgements', async () => {
      res = await h
        .api()
        .get(`${API}/policies/pending-acknowledgements`)
        .set('Authorization', `Bearer ${o.ownerToken}`);
    });
    then('the owner has nothing pending', () => {
      expect(res.status).toBe(200);
      expect((res.body.data as any[]).map((p) => p.id)).not.toContain(id);
    });
    and('the owner is not counted among who must acknowledge the policy', async () => {
      const status = await h
        .api()
        .get(`${API}/policies/${id}/acknowledgements`)
        .set('Authorization', `Bearer ${o.ownerToken}`)
        .expect(200);
      const everyone = [
        ...(status.body.data.pending as any[]),
        ...(status.body.data.acked as any[]),
      ].map((r) => r.userId);
      expect(everyone).not.toContain(o.ownerId);
    });
  });

  test('a work-from-office policy from the template requires consent to be geo-located', ({
    given,
    when,
    then,
    and,
  }) => {
    let o: CreatedOrg;
    let id: string;
    let res: request.Response;
    given('an organization owner', async () => {
      o = await org();
    });
    when(
      'the owner creates a policy from the "Work From Office (Geo-fenced, 2 km)" template',
      async () => {
        res = await h
          .api()
          .post(
            `${API}/policies/from-template/${encodeURIComponent(
              'Work From Office (Geo-fenced, 2 km)',
            )}`,
          )
          .set('Authorization', `Bearer ${o.ownerToken}`)
          .send({ applicableTo: 'all' });
        id = res.body?.data?.id;
      },
    );
    then('the created policy requires acknowledgement', () => {
      expect(res.status).toBe(201);
      expect(res.body.data.acknowledgementRequired).toBe(true);
      expect(res.body.data.workLocation?.mode).toBe('office');
    });
    and(
      'once activated, an applicable employee must consent before it takes effect',
      async () => {
        await h
          .api()
          .put(`${API}/policies/${id}/active`)
          .set('Authorization', `Bearer ${o.ownerToken}`)
          .send({ isActive: true })
          .expect(200);
        const emp = await h.createEmployeeMember(o);
        const pending = await h
          .api()
          .get(`${API}/policies/pending-acknowledgements`)
          .set('Authorization', `Bearer ${emp.token}`)
          .expect(200);
        expect((pending.body.data as any[]).map((p) => p.id)).toContain(id);
      },
    );
  });
});
