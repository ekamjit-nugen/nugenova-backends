import { attendanceFields, dayKey, decide, type ExistingRow, type LegacyAttendance } from './attendance-backfill';

/** The add-only policy: never overwrite real times, never copy empty rows. */
describe('attendance backfill policy', () => {
  const legacy = (over: Partial<LegacyAttendance> = {}): LegacyAttendance => ({
    _id: 'a1', employeeId: 'e1', date: '2026-09-14T00:00:00.000Z',
    checkInTime: '2026-09-14T05:50:00.000Z', checkOutTime: '2026-09-14T13:30:00.000Z', ...over,
  });
  const existing = (over: Partial<ExistingRow> = {}): ExistingRow => ({ id: 'p1', checkInTime: null, checkOutTime: null, ...over });

  it('inserts a day Postgres does not have at all', () => {
    expect(decide(legacy(), null)).toEqual({ action: 'insert' });
  });

  it('fills a day whose Postgres row has no times', () => {
    expect(decide(legacy(), existing())).toEqual({ action: 'fill' });
  });

  it('carries over a still-open shift (clock-in, no clock-out)', () => {
    expect(decide(legacy({ checkOutTime: null }), existing())).toEqual({ action: 'fill' });
    expect(decide(legacy({ checkOutTime: null }), null)).toEqual({ action: 'insert' });
  });

  it('never overwrites a Postgres row that already has times', () => {
    expect(decide(legacy(), existing({ checkInTime: new Date('2026-09-14T06:14:00Z') })).action).toBe('skip-has-times');
    expect(decide(legacy(), existing({ checkOutTime: new Date('2026-09-14T07:48:00Z') })).action).toBe('skip-has-times');
  });

  it('ignores legacy rows with no clock-in/out (absence placeholders) and deleted rows', () => {
    expect(decide(legacy({ checkInTime: null, checkOutTime: null }), existing()).action).toBe('skip-no-times');
    expect(decide(legacy({ checkInTime: null, checkOutTime: null }), null).action).toBe('skip-no-times');
    expect(decide(legacy({ isDeleted: true }), null).action).toBe('skip-deleted');
  });

  it('copies the clock-in/out detail, defaulting what legacy leaves out', () => {
    const f = attendanceFields(legacy({ workSegments: [{ checkInTime: 'x' }], totalWorkingHours: 7.66, status: 'late', isLateArrival: true, lateByMinutes: 12, missedCheckout: true }));
    expect(f).toMatchObject({ totalWorkingHours: 7.66, status: 'late', isLateArrival: true, lateByMinutes: 12, missedCheckout: true, overtimeHours: 0, isNightShift: false });
    expect(f.checkInTime?.toISOString()).toBe('2026-09-14T05:50:00.000Z');
    expect(f.workSegments).toHaveLength(1);
    expect(attendanceFields(legacy({ workSegments: undefined, status: undefined })).status).toBe('present');
    expect(attendanceFields(legacy({ workSegments: undefined })).workSegments).toEqual([]);
  });

  it('keys days by calendar date', () => {
    expect(dayKey(new Date('2026-09-14T18:30:00.000Z'))).toBe('2026-09-14');
  });
});
