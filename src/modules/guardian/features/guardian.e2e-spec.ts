import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import request from 'supertest';

import {
  bootOrgTestApp,
  OrgTestHarness,
  CreatedOrg,
} from '../../organization/features/support/org-harness';
import { GuardianLinkEntity } from '../entities/guardian-link.entity';
import { ConsentLedgerEntity } from '../entities/consent-ledger.entity';
import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';
import { newObjectId } from '../../../bootstrap/database/object-id';

const feature = loadFeature('./guardian.feature', { loadRelativePath: true });
const API = '/api/v1';

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let guardianLinks: Repository<GuardianLinkEntity>;
  let consents: Repository<ConsentLedgerEntity>;
  let memberships: Repository<OrgMembershipEntity>;
  const orgIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    guardianLinks = h.app.get(getRepositoryToken(GuardianLinkEntity));
    consents = h.app.get(getRepositoryToken(ConsentLedgerEntity));
    memberships = h.app.get(getRepositoryToken(OrgMembershipEntity));
  });
  afterAll(async () => {
    const ids = [...orgIds];
    if (ids.length) {
      await consents.delete({ organizationId: In(ids) }).catch(() => undefined);
      await guardianLinks.delete({ organizationId: In(ids) }).catch(() => undefined);
    }
    await h.cleanup();
  });

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const org = async () => {
    const o = await h.createOrg();
    orgIds.add(o.orgId);
    return o;
  };

  /** Insert a raw membership of a given personType (as the education vertical would). */
  const makeMember = async (
    o: CreatedOrg,
    personType: 'student' | 'guardian' | 'staff',
  ): Promise<string> => {
    const userId = newObjectId();
    h.trackUser(userId);
    const row = await memberships.save(
      memberships.create({
        organizationId: o.orgId,
        userId,
        email: `${personType}+${userId}@nugenova.test`,
        role: 'employee',
        status: 'active',
        personType,
      }),
    );
    return row.id;
  };

  const linkReq = (o: CreatedOrg, body: any) =>
    h.api().post(`${API}/guardian/links`).set(auth(o.ownerToken)).send(body);

  test('an admin links a guardian to a student', ({ given, when, then }) => {
    let o: CreatedOrg;
    let guardianId: string;
    let studentId: string;
    let res: request.Response;
    given('an organization with a guardian membership and a student membership', async () => {
      o = await org();
      guardianId = await makeMember(o, 'guardian');
      studentId = await makeMember(o, 'student');
    });
    when('the owner links the guardian to the student', async () => {
      res = await linkReq(o, {
        guardianMembershipId: guardianId,
        studentMembershipId: studentId,
        relationship: 'mother',
        isPrimary: true,
      });
    });
    then('the link is created', () => {
      expect(res.status).toBe(201);
      expect(res.body.data.guardianMembershipId).toBe(guardianId);
      expect(res.body.data.studentMembershipId).toBe(studentId);
      expect(res.body.data.isPrimary).toBe(true);
    });
  });

  test('a staff membership cannot be linked as a student', ({ given, when, then }) => {
    let o: CreatedOrg;
    let guardianId: string;
    let staffId: string;
    let res: request.Response;
    given('an organization with a guardian membership and a staff membership', async () => {
      o = await org();
      guardianId = await makeMember(o, 'guardian');
      staffId = await makeMember(o, 'staff');
    });
    when('the owner tries to link the guardian to the staff member', async () => {
      res = await linkReq(o, {
        guardianMembershipId: guardianId,
        studentMembershipId: staffId,
      });
    });
    then('the request is rejected as a bad request', () => {
      expect(res.status).toBe(400);
    });
  });

  test('an employee cannot author guardian links', ({ given, when, then }) => {
    let o: CreatedOrg;
    let emp: { token: string };
    let res: request.Response;
    given('an organization with an employee', async () => {
      o = await org();
      emp = await h.createEmployeeMember(o);
    });
    when('the employee tries to link a guardian', async () => {
      res = await h
        .api()
        .post(`${API}/guardian/links`)
        .set(auth(emp.token))
        .send({ guardianMembershipId: 'x', studentMembershipId: 'y' });
    });
    then('the request is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  test('a guardian consents for a linked student and it can be revoked', ({ given, when, then, and }) => {
    let o: CreatedOrg;
    let guardianId: string;
    let studentId: string;
    given('an organization with a guardian linked to a student', async () => {
      o = await org();
      guardianId = await makeMember(o, 'guardian');
      studentId = await makeMember(o, 'student');
      await linkReq(o, {
        guardianMembershipId: guardianId,
        studentMembershipId: studentId,
      }).expect(201);
    });
    when('the guardian consents to ai_tier_2 for the student', async () => {
      await h
        .api()
        .post(`${API}/guardian/consent`)
        .set(auth(o.ownerToken))
        .send({
          subjectMembershipId: studentId,
          purpose: 'ai_tier_2',
          grantedByMembershipId: guardianId,
        })
        .expect(201);
    });
    then('the purpose reads as consented for the student', async () => {
      const res = await h
        .api()
        .get(`${API}/guardian/consent/${studentId}/check`)
        .query({ purpose: 'ai_tier_2' })
        .set(auth(o.ownerToken))
        .expect(200);
      expect(res.body.data.consented).toBe(true);
    });
    and('after the owner revokes it the purpose reads as not consented', async () => {
      await h
        .api()
        .post(`${API}/guardian/consent/revoke`)
        .set(auth(o.ownerToken))
        .send({ subjectMembershipId: studentId, purpose: 'ai_tier_2' })
        .expect(200);
      const res = await h
        .api()
        .get(`${API}/guardian/consent/${studentId}/check`)
        .query({ purpose: 'ai_tier_2' })
        .set(auth(o.ownerToken))
        .expect(200);
      expect(res.body.data.consented).toBe(false);
    });
  });

  test('a guardian cannot consent for an unlinked student', ({ given, when, then }) => {
    let o: CreatedOrg;
    let guardianId: string;
    let studentId: string;
    let res: request.Response;
    given('an organization with a guardian and an unlinked student', async () => {
      o = await org();
      guardianId = await makeMember(o, 'guardian');
      studentId = await makeMember(o, 'student');
    });
    when('the guardian tries to consent for that student', async () => {
      res = await h
        .api()
        .post(`${API}/guardian/consent`)
        .set(auth(o.ownerToken))
        .send({
          subjectMembershipId: studentId,
          purpose: 'ai_tier_2',
          grantedByMembershipId: guardianId,
        });
    });
    then('the request is rejected as a bad request', () => {
      expect(res.status).toBe(400);
    });
  });
});
