import { AttendanceService, Caller } from './attendance.service';

/**
 * Focused unit spec for the chatbot's permission-gated attendance grounding.
 * Exercised on the prototype so we don't stand up the service's full repo graph
 * — `buildAiAttendanceContext` only ever calls `this.canViewOrgAttendance`
 * (pure) and `this.getDailyRoster` (stubbed here). The property under test is
 * the SECURITY GATE: managers/owners/admins get the roster, everyone else is
 * refused with no names leaked.
 */
describe('AttendanceService.buildAiAttendanceContext (AI permission gate)', () => {
  const svc = Object.create(AttendanceService.prototype) as AttendanceService;

  const caller = (over: Partial<Caller>): Caller => ({
    userId: 'u1',
    orgId: 'org1',
    roles: [],
    orgRole: 'employee',
    perms: null,
    permScoped: false,
    departmentScopeId: null,
    ...over,
  });

  const roster = {
    date: '2026-09-09',
    rows: [
      { userId: 'a', name: 'Ekamjit', email: null, role: 'manager', status: 'present', checkInTime: '2026-09-09T06:00:00.000Z', checkOutTime: null, totalHours: 1, isLateArrival: true, lateByMinutes: 30, missedCheckout: false },
      { userId: 'b', name: 'Nisha', email: null, role: 'employee', status: 'not_clocked_in', checkInTime: null, checkOutTime: null, totalHours: null, isLateArrival: false, lateByMinutes: 0, missedCheckout: false },
    ],
    summary: { total: 2, clockedIn: 1, notClockedIn: 1, onLeave: 0, absent: 0 },
  };

  it('returns null for a non-attendance question (even for an owner)', async () => {
    const out = await svc.buildAiAttendanceContext(
      caller({ orgRole: 'owner' }),
      'Summarize the employee handbook.',
    );
    expect(out).toBeNull();
  });

  it('refuses — and leaks NO roster data — for an employee without attendance:view', async () => {
    const spy = jest.spyOn(svc, 'getDailyRoster');
    const out = await svc.buildAiAttendanceContext(
      caller({ orgRole: 'employee' }),
      'Who is present today and who has not clocked in?',
    );
    expect(out).toMatch(/permission|decline|do NOT/i);
    expect(out).not.toMatch(/Nisha|Ekamjit/);
    expect(spy).not.toHaveBeenCalled(); // never even queries the roster
    spy.mockRestore();
  });

  it('grounds on the roster for an owner/admin', async () => {
    const spy = jest.spyOn(svc, 'getDailyRoster').mockResolvedValue(roster as any);
    const out = await svc.buildAiAttendanceContext(
      caller({ orgRole: 'owner' }),
      "Who hasn't clocked in today?",
    );
    expect(spy).toHaveBeenCalled();
    expect(out).toContain('Not clocked in (1): Nisha');
    expect(out).toContain('Clocked in (1): Ekamjit');
    expect(out).toContain('late 30m');
    spy.mockRestore();
  });

  it('grounds for a permScoped custom role granted attendance:view (the manager case)', async () => {
    const spy = jest.spyOn(svc, 'getDailyRoster').mockResolvedValue(roster as any);
    const out = await svc.buildAiAttendanceContext(
      caller({ orgRole: 'employee', permScoped: true, perms: { attendance: ['view'] } }),
      'who is in the office right now?',
    );
    expect(spy).toHaveBeenCalled();
    expect(out).toContain('LIVE ATTENDANCE');
    spy.mockRestore();
  });
});
