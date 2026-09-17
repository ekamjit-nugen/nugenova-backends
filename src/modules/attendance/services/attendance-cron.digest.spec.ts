import { AttendanceCronService } from './attendance-cron.service';
import { OrgEmailRouting } from '../../notification/email-routing.service';

/**
 * The daily attendance summary — the email that reached Sakshi (an employee whose
 * SALES role grants attendance:view). Builds the real service with the real
 * routing rules; only the repositories and mail transport are faked.
 */
describe('AttendanceCronService — daily attendance summary recipients', () => {
  const ORG = { id: 'org1', name: 'Nugen IT Services', status: 'active', settings: null };
  const people: Record<string, { firstName: string; email: string }> = {
    'u-owner': { firstName: 'Varun', email: 'cto.varun@gmail.com' },
    'u-admin': { firstName: 'Accounts', email: 'accounts@nugeninfo.com' },
    'u-hr': { firstName: 'Hema', email: 'hr@nugeninfo.com' },
    'u-sakshi': { firstName: 'Sakshi', email: 'sakshimittal@nugeninfo.com' },
  };
  const MEMBERS = [
    { userId: 'u-owner', role: 'owner', roleId: null, secondaryRoleId: null, status: 'active', personType: 'staff' },
    { userId: 'u-admin', role: 'admin', roleId: 'r-admin', secondaryRoleId: null, status: 'active', personType: 'staff' },
    { userId: 'u-hr', role: 'manager', roleId: 'r-hr', secondaryRoleId: null, status: 'active', personType: 'staff' },
    { userId: 'u-sakshi', role: 'employee', roleId: 'r-sales', secondaryRoleId: null, status: 'active', personType: 'staff' },
  ] as any[];

  let send: jest.Mock;
  let notifyManagers: jest.Mock;
  let resolveManagers: jest.Mock;

  const build = (overrides: Record<string, Record<string, boolean>>) => {
    send = jest.fn().mockResolvedValue(true);
    notifyManagers = jest.fn().mockResolvedValue(undefined);
    // Everyone below holds attendance:view — exactly who the OLD code emailed.
    resolveManagers = jest.fn().mockResolvedValue(['u-owner', 'u-admin', 'u-hr', 'u-sakshi']);
    const repo = (extra: object) => ({ find: jest.fn(), findOne: jest.fn(), ...extra });
    return new AttendanceCronService(
      repo({ find: jest.fn().mockResolvedValue([{ status: 'absent' }, { isLateArrival: true }]) }) as any, // attendance
      repo({}) as any, // holidays
      repo({}) as any, // wfh
      repo({ find: jest.fn().mockResolvedValue([ORG]), findOne: jest.fn().mockResolvedValue(ORG) }) as any, // orgs
      repo({}) as any, // memberships
      repo({ findOne: jest.fn(async ({ where }) => ({ id: where.id, lastName: '', ...people[where.id] })) }) as any, // users
      repo({}) as any, // leaves
      repo({}) as any, // onboardings
      {} as any, // policy
      { notifyManagers, resolveManagers } as any,
      { forOrg: jest.fn().mockResolvedValue(new OrgEmailRouting(overrides, MEMBERS)) } as any,
      { send } as any,
      { get: jest.fn().mockReturnValue('https://nugenova.com') } as any,
      {} as any, // attendanceService
    );
  };

  const recipients = () => send.mock.calls.map((c) => c[0].to).sort();

  it('emails owners and admins by default — not Sakshi, even though she can view attendance', async () => {
    await build({}).sendDailyExceptionDigest(new Date('2026-09-17T03:00:00Z'), 'org1');
    expect(recipients()).toEqual(['accounts@nugeninfo.com', 'cto.varun@gmail.com']);
    expect(recipients()).not.toContain('sakshimittal@nugeninfo.com');
    expect(send.mock.calls[0][0].category).toBe('attendance.daily_digest');
    // The recipient list no longer comes from the attendance:view permission.
    expect(resolveManagers).not.toHaveBeenCalled();
  });

  it('adds HR once the HR role is ticked on the Roles page', async () => {
    await build({ 'attendance.daily_digest': { 'role:r-hr': true } }).sendDailyExceptionDigest(
      new Date('2026-09-17T03:00:00Z'),
      'org1',
    );
    expect(recipients()).toEqual(['accounts@nugeninfo.com', 'cto.varun@gmail.com', 'hr@nugeninfo.com']);
  });

  it('still posts the in-app summary for everyone who can view attendance', async () => {
    await build({}).sendDailyExceptionDigest(new Date('2026-09-17T03:00:00Z'), 'org1');
    expect(notifyManagers).toHaveBeenCalledWith(expect.objectContaining({ resource: 'attendance', action: 'view', type: 'attendance_daily_digest' }));
  });
});
