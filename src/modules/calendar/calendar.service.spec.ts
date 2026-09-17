import { CalendarService } from './calendar.service';

/**
 * Pure unit spec — no DB. All five repositories are jest mocks returning canned
 * rows, so we exercise the aggregation logic directly: the WFH split, real-name
 * resolution, the meeting access filter, recurrence expansion and birthday
 * projection.
 */
describe('CalendarService (unit, no DB)', () => {
  const FROM = new Date('2026-09-01T00:00:00.000Z');
  const TO = new Date('2026-09-30T23:59:59.999Z');
  const member = { userId: 'u2', isAdmin: false };
  const admin = { userId: 'admin1', isAdmin: true };

  // FindOperator (In(ids)) unwrap, mirroring meetings.service.spec.
  const unwrapIds = (op: any): string[] => op?._value ?? op?.value ?? [];

  const build = (opts: {
    people?: Array<{ id: string; firstName?: string; lastName?: string; dob?: string | null }>;
    holidays?: any[];
    leaves?: any[];
    meetings?: any[];
  }) => {
    const people = opts.people ?? [{ id: 'u2', firstName: 'Emp', lastName: 'Loyee', dob: null }];
    const membershipsRepo = { find: jest.fn(() => Promise.resolve(people.map((p) => ({ userId: p.id, status: 'active' })))) };
    const usersRepo = {
      find: jest.fn(({ where }) => {
        const ids = unwrapIds(where.id);
        return Promise.resolve(
          people
            .filter((p) => ids.includes(p.id))
            .map((p) => ({ id: p.id, firstName: p.firstName ?? p.id, lastName: p.lastName ?? '', email: `${p.id}@x.com`, dateOfBirth: p.dob ? new Date(p.dob) : null })),
        );
      }),
    };
    const holidaysRepo = { find: jest.fn(() => Promise.resolve(opts.holidays ?? [])) };
    const leavesRepo = { find: jest.fn(() => Promise.resolve(opts.leaves ?? [])) };
    const meetingsRepo = { find: jest.fn(() => Promise.resolve(opts.meetings ?? [])) };
    return new CalendarService(holidaysRepo as any, leavesRepo as any, meetingsRepo as any, membershipsRepo as any, usersRepo as any);
  };

  it('splits work-from-home into its own type and resolves the real name for leave', async () => {
    const svc = build({
      leaves: [
        { id: 'l1', userId: 'u2', employeeName: null, leaveType: 'casual', startDate: new Date('2026-09-10'), endDate: new Date('2026-09-10'), halfDay: false },
        { id: 'l2', userId: 'u2', employeeName: null, leaveType: 'wfh', startDate: new Date('2026-09-12'), endDate: new Date('2026-09-12'), halfDay: false },
      ],
    });
    const events = await svc.getEvents('orgA', member, FROM, TO);
    const leave = events.find((e) => e.type === 'leave');
    const wfh = events.find((e) => e.type === 'wfh');
    expect(leave?.title).toContain('Emp Loyee');
    expect(wfh).toBeTruthy();
    expect(wfh?.type).toBe('wfh'); // NOT 'leave'
  });

  it('includes only meetings the caller can access', async () => {
    const meetings = [
      { id: 'mA', title: 'Others only', hostId: 'other', participants: [], scheduledStart: new Date('2026-09-05T10:00:00Z'), scheduledEnd: new Date('2026-09-05T11:00:00Z'), recurrence: 'none', status: 'scheduled' },
      { id: 'mB', title: 'Invited', hostId: 'other', participants: [{ userId: 'u2', name: 'Emp' }], scheduledStart: new Date('2026-09-06T10:00:00Z'), scheduledEnd: new Date('2026-09-06T11:00:00Z'), recurrence: 'none', status: 'scheduled' },
    ];
    const asMember = await build({ meetings }).getEvents('orgA', member, FROM, TO);
    const ids = asMember.filter((e) => e.type === 'meeting').map((e) => e.meta?.meetingId);
    expect(ids).toEqual(['mB']); // only the meeting they were invited to

    const asAdmin = await build({ meetings }).getEvents('orgA', admin, FROM, TO);
    const adminIds = asAdmin.filter((e) => e.type === 'meeting').map((e) => e.meta?.meetingId).sort();
    expect(adminIds).toEqual(['mA', 'mB']); // admin sees all
  });

  it('expands a weekly meeting into one occurrence per week in the window', async () => {
    const svc = build({
      meetings: [
        { id: 'mW', title: 'Weekly', hostId: 'u2', participants: [], scheduledStart: new Date('2026-09-01T09:00:00Z'), scheduledEnd: new Date('2026-09-01T09:30:00Z'), recurrence: 'weekly', status: 'scheduled' },
      ],
    });
    const events = await svc.getEvents('orgA', member, FROM, TO);
    const occ = events.filter((e) => e.type === 'meeting' && e.meta?.meetingId === 'mW');
    // Sep 1, 8, 15, 22, 29 → 5 occurrences.
    expect(occ.length).toBe(5);
  });

  it('projects a birthday from the date of birth onto the window', async () => {
    const svc = build({ people: [{ id: 'u2', firstName: 'Emp', lastName: 'Loyee', dob: '1990-09-20' }] });
    const events = await svc.getEvents('orgA', member, FROM, TO);
    const bday = events.find((e) => e.type === 'birthday' && e.meta?.userId === 'u2');
    expect(bday).toBeTruthy();
    expect(bday?.allDay).toBe(true);
  });

  it('emits holidays as all-day events', async () => {
    const svc = build({ holidays: [{ id: 'h1', name: 'Founders Day', date: new Date('2026-09-15T00:00:00Z'), type: 'other' }] });
    const events = await svc.getEvents('orgA', member, FROM, TO);
    const holiday = events.find((e) => e.type === 'holiday');
    expect(holiday?.title).toBe('Founders Day');
    expect(holiday?.allDay).toBe(true);
  });

  it("shows a member only their own leave, and the team's to someone who manages leave", async () => {
    const leaves = [
      { id: 'l1', userId: 'u2', employeeName: null, leaveType: 'casual', startDate: new Date('2026-09-10'), endDate: new Date('2026-09-10'), halfDay: false },
    ];
    const people = [{ id: 'u2', firstName: 'Emp', lastName: 'Loyee', dob: null }];
    const memberSvc = build({ people, leaves });
    await memberSvc.getEvents('orgA', member, FROM, TO);
    const memberWhere = ((memberSvc as any).leaves.find as jest.Mock).mock.calls[0][0].where;
    expect(memberWhere.userId).toBe('u2');

    const managerSvc = build({ people, leaves });
    await managerSvc.getEvents('orgA', { userId: 'u9', isAdmin: false, canSeeTeamLeave: true }, FROM, TO);
    expect(((managerSvc as any).leaves.find as jest.Mock).mock.calls[0][0].where.userId).toBeUndefined();

    const adminSvc = build({ people, leaves });
    await adminSvc.getEvents('orgA', admin, FROM, TO);
    expect(((adminSvc as any).leaves.find as jest.Mock).mock.calls[0][0].where.userId).toBeUndefined();
  });
});
