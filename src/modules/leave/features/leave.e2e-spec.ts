import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import request from 'supertest';

import {
  bootOrgTestApp,
  OrgTestHarness,
  CreatedOrg,
} from '../../organization/features/support/org-harness';
import { LeaveRequestEntity } from '../entities/leave-request.entity';
import { LeaveBalanceEntity } from '../entities/leave-balance.entity';

const feature = loadFeature('./leave.feature', { loadRelativePath: true });
const API = '/api/v1';

interface Member {
  email: string;
  userId: string;
  token: string;
}

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let leaves: Repository<LeaveRequestEntity>;
  let balances: Repository<LeaveBalanceEntity>;
  const orgIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    leaves = h.app.get(getRepositoryToken(LeaveRequestEntity));
    balances = h.app.get(getRepositoryToken(LeaveBalanceEntity));
  });
  afterAll(async () => {
    const ids = [...orgIds];
    if (ids.length) {
      await leaves.delete({ organizationId: In(ids) }).catch(() => undefined);
      await balances.delete({ organizationId: In(ids) }).catch(() => undefined);
    }
    await h.cleanup();
  });

  const orgWithMember = async (): Promise<{ o: CreatedOrg; member: Member }> => {
    const o = await h.createOrg();
    orgIds.add(o.orgId);
    const member = await h.createEmployeeMember(o);
    return { o, member };
  };

  const apply = (member: Member, body: any) =>
    h.api().post(`${API}/leaves`).set('Authorization', `Bearer ${member.token}`).send(body);

  const casual = (startDate: string, endDate: string, extra: any = {}) => ({
    leaveType: 'casual',
    startDate,
    endDate,
    reason: 'Personal',
    ...extra,
  });

  const balanceOf = async (member: Member, type: string) => {
    const res = await h
      .api()
      .get(`${API}/leaves/balance`)
      .set('Authorization', `Bearer ${member.token}`)
      .expect(200);
    return (res.body.data.balances as any[]).find((b) => b.leaveType === type);
  };

  test('a member sees their leave balance seeded from the catalog', ({ given, when, then }) => {
    let member: Member;
    let res: request.Response;
    given('an organization with an employee member', async () => {
      ({ member } = await orgWithMember());
    });
    when('the employee reads their leave balance', async () => {
      res = await h.api().get(`${API}/leaves/balance`).set('Authorization', `Bearer ${member.token}`);
    });
    then('the balance lists casual, sick and earned with their default allocations', () => {
      expect(res.status).toBe(200);
      const byType = new Map((res.body.data.balances as any[]).map((b) => [b.leaveType, b]));
      expect(byType.get('casual').available).toBe(12);
      expect(byType.get('sick').available).toBe(12);
      expect(byType.get('earned').available).toBe(15);
    });
  });

  test('a member applies for casual leave', ({ given, when, then }) => {
    let member: Member;
    let res: request.Response;
    given('an organization with an employee member', async () => {
      ({ member } = await orgWithMember());
    });
    when('the employee applies for 2 days of casual leave', async () => {
      // Tue 2026-09-01 .. Wed 2026-09-02
      res = await apply(member, casual('2026-09-01', '2026-09-02'));
    });
    then('the leave is created as pending with 2 total days', () => {
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('pending');
      expect(res.body.data.totalDays).toBe(2);
    });
  });

  test('applying counts business days and excludes weekends', ({ given, when, then }) => {
    let member: Member;
    let res: request.Response;
    given('an organization with an employee member', async () => {
      ({ member } = await orgWithMember());
    });
    when('the employee applies for casual leave spanning a weekend', async () => {
      // Fri 2026-09-04 .. Mon 2026-09-07 (Sat/Sun excluded) = 2
      res = await apply(member, casual('2026-09-04', '2026-09-07'));
    });
    then('only the weekdays are counted', () => {
      expect(res.status).toBe(201);
      expect(res.body.data.totalDays).toBe(2);
    });
  });

  test('overlapping leave is rejected', ({ given, when, then }) => {
    let member: Member;
    let res: request.Response;
    given('an organization with an employee member who has a pending leave', async () => {
      ({ member } = await orgWithMember());
      await apply(member, casual('2026-09-01', '2026-09-02')).expect(201);
    });
    when('the employee applies for a leave that overlaps it', async () => {
      res = await apply(member, casual('2026-09-02', '2026-09-03'));
    });
    then('the second application is rejected as a conflict', () => {
      expect(res.status).toBe(409);
    });
  });

  test('applying for more than the balance is blocked', ({ given, when, then }) => {
    let member: Member;
    let res: request.Response;
    given('an organization with an employee member', async () => {
      ({ member } = await orgWithMember());
    });
    when('the employee applies for more casual days than they have', async () => {
      // Whole month → ~22 business days > 12 casual
      res = await apply(member, casual('2026-09-01', '2026-09-30'));
    });
    then('the application is rejected as a bad request', () => {
      expect(res.status).toBe(400);
    });
  });

  test('approval deducts the balance', ({ given, when, then }) => {
    let o: CreatedOrg;
    let member: Member;
    let id: string;
    given('an organization with an employee member who applied for 2 casual days', async () => {
      ({ o, member } = await orgWithMember());
      const res = await apply(member, casual('2026-09-01', '2026-09-02')).expect(201);
      id = res.body.data.id;
    });
    when('the owner approves the leave', async () => {
      await h
        .api()
        .put(`${API}/leaves/${id}/approve`)
        .set('Authorization', `Bearer ${o.ownerToken}`)
        .expect(200);
    });
    then('the leave is approved and 2 casual days are deducted from the balance', async () => {
      const line = await balanceOf(member, 'casual');
      expect(line.used).toBe(2);
      expect(line.available).toBe(10);
    });
  });

  test('cancelling an approved leave restores the balance', ({ given, when, then }) => {
    let o: CreatedOrg;
    let member: Member;
    let id: string;
    given('an organization with an employee member whose 2-day casual leave was approved', async () => {
      ({ o, member } = await orgWithMember());
      const res = await apply(member, casual('2026-09-01', '2026-09-02')).expect(201);
      id = res.body.data.id;
      await h.api().put(`${API}/leaves/${id}/approve`).set('Authorization', `Bearer ${o.ownerToken}`).expect(200);
    });
    when('the employee cancels the leave', async () => {
      await h
        .api()
        .put(`${API}/leaves/${id}/cancel`)
        .set('Authorization', `Bearer ${member.token}`)
        .send({})
        .expect(200);
    });
    then('the leave is cancelled and the 2 casual days are restored', async () => {
      const line = await balanceOf(member, 'casual');
      expect(line.used).toBe(0);
      expect(line.available).toBe(12);
    });
  });

  test('rejecting a leave records the reason and leaves the balance untouched', ({ given, when, then }) => {
    let o: CreatedOrg;
    let member: Member;
    let id: string;
    let res: request.Response;
    given('an organization with an employee member who applied for 2 casual days', async () => {
      ({ o, member } = await orgWithMember());
      const a = await apply(member, casual('2026-09-01', '2026-09-02')).expect(201);
      id = a.body.data.id;
    });
    when('the owner rejects the leave with a reason', async () => {
      res = await h
        .api()
        .put(`${API}/leaves/${id}/reject`)
        .set('Authorization', `Bearer ${o.ownerToken}`)
        .send({ reason: 'Team crunch that week' });
    });
    then('the leave is rejected and no balance is deducted', async () => {
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('rejected');
      expect(res.body.data.reviewNote).toBe('Team crunch that week');
      const line = await balanceOf(member, 'casual');
      expect(line.available).toBe(12);
    });
  });

  test('an owner cannot apply for leave', ({ given, when, then }) => {
    let o: CreatedOrg;
    let res: request.Response;
    given('an organization with an employee member', async () => {
      ({ o } = await orgWithMember());
    });
    when('the owner tries to apply for leave', async () => {
      res = await h
        .api()
        .post(`${API}/leaves`)
        .set('Authorization', `Bearer ${o.ownerToken}`)
        .send(casual('2026-09-01', '2026-09-02'));
    });
    then('the application is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  test('an employee cannot approve leave', ({ given, when, then }) => {
    let o: CreatedOrg;
    let member: Member;
    let other: Member;
    let id: string;
    let res: request.Response;
    given('an organization with an employee member who applied for 2 casual days', async () => {
      ({ o, member } = await orgWithMember());
      other = await h.createEmployeeMember(o);
      const a = await apply(member, casual('2026-09-01', '2026-09-02')).expect(201);
      id = a.body.data.id;
    });
    when('another plain employee tries to approve the leave', async () => {
      res = await h
        .api()
        .put(`${API}/leaves/${id}/approve`)
        .set('Authorization', `Bearer ${other.token}`);
    });
    then('the approval is rejected as forbidden', () => {
      expect(res.status).toBe(403);
    });
  });

  test('loss-of-pay ignores the balance entirely', ({ given, when, then }) => {
    let member: Member;
    let res: request.Response;
    given('an organization with an employee member', async () => {
      ({ member } = await orgWithMember());
    });
    when('the employee applies for loss-of-pay leave', async () => {
      // A long range that would exceed any tracked balance — lop has none.
      res = await apply(member, { leaveType: 'lop', startDate: '2026-09-01', endDate: '2026-09-30', reason: 'Unpaid time' });
    });
    then('the leave is created without any balance check', () => {
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('pending');
      expect(res.body.data.leaveType).toBe('lop');
    });
  });

  test('owner-configured allocation drives the balance', ({ given, when, then }) => {
    let o: CreatedOrg;
    let member: Member;
    given('an organization with an employee member', async () => {
      ({ o, member } = await orgWithMember());
    });
    when('the owner sets the casual leave allocation to 18', async () => {
      await h
        .api()
        .put(`${API}/policies/leave-config`)
        .set('Authorization', `Bearer ${o.ownerToken}`)
        .send({ leaveTypes: [{ key: 'casual', annualAllocation: 18, enabled: true }] })
        .expect(200);
    });
    then("the member's casual balance reflects 18 days", async () => {
      const line = await balanceOf(member, 'casual');
      expect(line.opening).toBe(18);
      expect(line.available).toBe(18);
    });
  });

  test('owner adds a custom leave type that members can use', ({ given, when, then, and }) => {
    let o: CreatedOrg;
    let member: Member;
    let leaveId: string;
    given('an organization with an employee member', async () => {
      ({ o, member } = await orgWithMember());
    });
    when('the owner adds a custom "Study Leave" type with 10 days', async () => {
      await h
        .api()
        .put(`${API}/policies/leave-config`)
        .set('Authorization', `Bearer ${o.ownerToken}`)
        .send({ leaveTypes: [{ key: 'study_leave', label: 'Study Leave', annualAllocation: 10, enabled: true }] })
        .expect(200);
    });
    then('the member sees Study Leave among their leave types', async () => {
      const res = await h
        .api()
        .get(`${API}/leaves/types`)
        .set('Authorization', `Bearer ${member.token}`)
        .expect(200);
      const study = (res.body.data as any[]).find((t) => t.key === 'study_leave');
      expect(study).toBeDefined();
      expect(study.label).toBe('Study Leave');
      expect(study.annualAllocation).toBe(10);
    });
    and(
      'the member can apply for Study Leave and it deducts from that balance on approval',
      async () => {
        const applied = await apply(member, {
          leaveType: 'study_leave',
          startDate: '2026-09-01',
          endDate: '2026-09-02',
          reason: 'Exam prep',
        }).expect(201);
        leaveId = applied.body.data.id;
        expect(applied.body.data.leaveTypeLabel).toBe('Study Leave');
        await h
          .api()
          .put(`${API}/leaves/${leaveId}/approve`)
          .set('Authorization', `Bearer ${o.ownerToken}`)
          .expect(200);
        const line = await balanceOf(member, 'study_leave');
        expect(line.used).toBe(2);
        expect(line.available).toBe(8);
      },
    );
  });
});
