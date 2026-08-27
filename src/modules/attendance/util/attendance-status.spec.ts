import {
  RECORD_STATUSES,
  CALENDAR_STATUSES,
  bucketForStatus,
} from './attendance-status';

/**
 * G-X1 — one canonical status vocabulary shared by the persisted enum, the
 * calendar projection, and the payroll day-summary. Guards against the drift
 * where a status silently maps to no payroll day.
 */
describe('attendance-status (G-X1)', () => {
  it('persists exactly the canonical record statuses', () => {
    expect([...RECORD_STATUSES]).toEqual([
      'present',
      'late',
      'half_day',
      'absent',
      'holiday',
      'leave',
      'wfh',
      'comp_off',
    ]);
  });

  it('adds weekoff only on the calendar projection, never persisted', () => {
    expect(CALENDAR_STATUSES).toContain('weekoff');
    expect([...RECORD_STATUSES]).not.toContain('weekoff' as never);
  });

  it.each([
    ['present', 'present'],
    ['late', 'present'],
    ['wfh', 'present'],
    ['comp_off', 'present'],
    ['half_day', 'half'],
    ['absent', 'absent'],
    ['leave', 'paidLeave'],
    ['holiday', 'holiday'],
    ['weekoff', 'weekoff'],
  ])('maps %s to the %s payroll bucket', (status, bucket) => {
    expect(bucketForStatus(status)).toBe(bucket);
  });

  it('INV-STATUS-1: every calendar status has a defined bucket (no silent drop)', () => {
    for (const s of CALENDAR_STATUSES) {
      expect(bucketForStatus(s)).not.toBe('none');
    }
  });

  it('maps an unknown status to none rather than counting it as a day', () => {
    expect(bucketForStatus('bogus')).toBe('none');
  });
});
