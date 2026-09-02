import { defineFeature, loadFeature } from 'jest-cucumber';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Between, In, Repository } from 'typeorm';

import { bootOrgTestApp, OrgTestHarness, CreatedOrg } from '../../organization/features/support/org-harness';
import { AttendanceEntity } from '../entities/attendance.entity';
import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';
import { LeaveRequestEntity } from '../../leave/entities/leave-request.entity';
import { AttendanceCronService } from '../services/attendance-cron.service';

const feature = loadFeature('./attendance-cron.feature', { loadRelativePath: true });
const API = '/api/v1';

// A fixed clock so "yesterday" is a deterministic weekday (Wed 2026-08-26).
const NOW = new Date('2026-08-27T06:00:00.000Z');
const WORK_DAY = new Date('2026-08-26T00:00:00.000Z'); // Wednesday, org-local anchor

interface Member { email: string; userId: string; token: string }

defineFeature(feature, (test) => {
  let h: OrgTestHarness;
  let cron: AttendanceCronService;
  let attendance: Repository<AttendanceEntity>;
  let memberships: Repository<OrgMembershipEntity>;
  let leaves: Repository<LeaveRequestEntity>;
  const orgIds = new Set<string>();

  beforeAll(async () => {
    h = await bootOrgTestApp();
    cron = h.app.get(AttendanceCronService);
    attendance = h.app.get(getRepositoryToken(AttendanceEntity));
    memberships = h.app.get(getRepositoryToken(OrgMembershipEntity));
    leaves = h.app.get(getRepositoryToken(LeaveRequestEntity));
  });
  afterAll(async () => {
    const ids = [...orgIds];
    if (ids.length) {
      await attendance.delete({ organizationId: In(ids) }).catch(() => undefined);
      await leaves.delete({ organizationId: In(ids) }).catch(() => undefined);
    }
    await h.cleanup();
  });

  // Fresh org + employee whose membership joined well before the target day.
  const setup = async (): Promise<{ o: CreatedOrg; member: Member }> => {
    const o = await h.createOrg();
    orgIds.add(o.orgId);
    const member = await h.createEmployeeMember(o);
    await memberships.update(
      { organizationId: o.orgId, userId: member.userId },
      { joinedAt: new Date('2026-01-01T00:00:00.000Z') },
    );
    return { o, member };
  };

  const recordsOn = (orgId: string, userId: string) =>
    attendance.find({
      where: {
        organizationId: orgId,
        employeeId: userId,
        date: Between(new Date('2026-08-26T00:00:00.000Z'), new Date('2026-08-26T23:59:59.999Z')),
        isDeleted: false,
      },
    });

  test('an employee with no record on a past working day is marked absent', ({ given, when, then, and }) => {
    let o: CreatedOrg;
    let member: Member;

    given('an organization with a tracked employee who joined long ago', async () => {
      ({ o, member } = await setup());
    });
    when('the absentee job runs for the day after a past working day', async () => {
      const n = await cron.markAbsentees(NOW, o.orgId);
      expect(n).toBeGreaterThanOrEqual(1);
    });
    then('that employee has an absent record for that day', async () => {
      const rows = await recordsOn(o.orgId, member.userId);
      expect(rows.length).toBe(1);
      expect(rows[0].status).toBe('absent');
      expect(rows[0].entryType).toBe('system');
    });
    and('the employee is notified that they were marked absent', async () => {
      const res = await h.api().get(`${API}/notifications`).set('Authorization', `Bearer ${member.token}`).expect(200);
      const items = (res.body.items || []) as Array<{ type: string }>;
      expect(items.some((n) => n.type === 'attendance_absent')).toBe(true);
    });
  });

  test('an employee on approved leave is not marked absent', ({ given, and, when, then }) => {
    let o: CreatedOrg;
    let member: Member;

    given('an organization with a tracked employee who joined long ago', async () => {
      ({ o, member } = await setup());
    });
    and('the employee has approved leave covering that working day', async () => {
      await leaves.save(
        leaves.create({
          organizationId: o.orgId,
          userId: member.userId,
          leaveType: 'casual',
          reason: 'Vacation',
          startDate: new Date('2026-08-25T00:00:00.000Z'),
          endDate: new Date('2026-08-27T00:00:00.000Z'),
          totalDays: 3,
          status: 'approved',
        } as Partial<LeaveRequestEntity>),
      );
    });
    when('the absentee job runs for the day after that working day', async () => {
      await cron.markAbsentees(NOW, o.orgId);
    });
    then('that employee has no attendance record for that day', async () => {
      const rows = await recordsOn(o.orgId, member.userId);
      expect(rows.length).toBe(0);
    });
  });

  test('a session left open past the day is auto-closed', ({ given, and, when, then }) => {
    let o: CreatedOrg;
    let member: Member;

    given('an organization with a tracked employee who joined long ago', async () => {
      ({ o, member } = await setup());
    });
    and('the employee has a clock-in with no clock-out from two days ago', async () => {
      const checkIn = new Date('2026-08-25T03:30:00.000Z');
      await attendance.save(
        attendance.create({
          organizationId: o.orgId,
          employeeId: member.userId,
          date: new Date('2026-08-25T00:00:00.000Z'),
          checkInTime: checkIn,
          checkOutTime: null,
          status: 'present',
          entryType: 'system',
          workSegments: [{ checkInTime: checkIn.toISOString(), checkOutTime: null }] as any,
        }),
      );
    });
    when('the missed-checkout reconcile job runs', async () => {
      const n = await cron.reconcileMissedCheckouts(NOW, o.orgId);
      expect(n).toBeGreaterThanOrEqual(1);
    });
    then('the session is closed as a missed checkout with computed hours', async () => {
      const rows = await attendance.find({
        where: {
          organizationId: o.orgId,
          employeeId: member.userId,
          date: Between(new Date('2026-08-25T00:00:00.000Z'), new Date('2026-08-25T23:59:59.999Z')),
        },
      });
      expect(rows.length).toBe(1);
      expect(rows[0].checkOutTime).not.toBeNull();
      expect(rows[0].missedCheckout).toBe(true);
      expect(rows[0].autoCheckedOut).toBe(true);
      expect(Number(rows[0].effectiveWorkingHours)).toBeGreaterThan(0);
    });
  });

  test("yesterday's exceptions are summarised to admins", ({ given, and, when, then }) => {
    let o: CreatedOrg;
    let member: Member;

    given('an organization with a tracked employee who joined long ago', async () => {
      ({ o, member } = await setup());
    });
    and('that employee was marked absent for the previous working day', async () => {
      await attendance.save(
        attendance.create({
          organizationId: o.orgId,
          employeeId: member.userId,
          date: WORK_DAY,
          checkInTime: null,
          checkOutTime: null,
          status: 'absent',
          entryType: 'system',
          workSegments: [],
        }),
      );
    });
    when('the daily digest job runs', async () => {
      const n = await cron.sendDailyExceptionDigest(NOW, o.orgId);
      expect(n).toBe(1);
    });
    then('a digest is sent for that organization', async () => {
      const res = await h.api().get(`${API}/notifications`).set('Authorization', `Bearer ${o.ownerToken}`).expect(200);
      const items = (res.body.items || []) as Array<{ type: string }>;
      expect(items.some((n) => n.type === 'attendance_daily_digest')).toBe(true);
    });
  });
});
