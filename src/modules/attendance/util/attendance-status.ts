/**
 * Canonical attendance status vocabulary (G-X1).
 *
 * One source of truth shared by the persisted entity enum, the calendar
 * projection, and the payroll day-summary. In the monolith each layer once
 * carried its own list: the schema persisted `present|late|half_day|absent|
 * holiday|leave|wfh|comp_off`, `getMyCalendar` emitted `weekoff` (never
 * persisted), and payroll's `getDaysSummary` switched on `lop|paid_leave|
 * weekoff` (never produced) while silently dropping `late`/`wfh`/`comp_off`.
 * Centralising the set + the payroll mapping here removes that drift.
 *
 * Ported verbatim from the Nugenova monolith (attendance/util/attendance-status.ts).
 */

/** Statuses that can be PERSISTED on an attendance record (entity enum). */
export const RECORD_STATUSES = [
  'present',
  'late',
  'half_day',
  'absent',
  'holiday',
  'leave',
  'wfh',
  'comp_off',
] as const;

export type RecordStatus = (typeof RECORD_STATUSES)[number];

/** Synthesized at read time by the calendar but never written to a record. */
export const CALENDAR_ONLY_STATUSES = ['weekoff'] as const;

/** Everything the calendar view can show. */
export const CALENDAR_STATUSES = [
  ...RECORD_STATUSES,
  ...CALENDAR_ONLY_STATUSES,
] as const;

export type CalendarStatus = (typeof CALENDAR_STATUSES)[number];

/** The payroll day-summary counters a status contributes to. */
export type PayrollBucket =
  | 'present'
  | 'half'
  | 'absent'
  | 'paidLeave'
  | 'holiday'
  | 'weekoff'
  | 'none';

/**
 * Map a status to its payroll bucket. `late`, `wfh` and `comp_off` are WORKED
 * (or worked-equivalent paid) days → counted as present. Attendance-level
 * `leave` is treated as paid here; the paid/unpaid (LOP) split is owned by
 * leave-service and applied separately by the payroll calc engine. Unknown
 * statuses map to `none` so a typo is never accidentally counted as a day.
 */
const BUCKET: Record<string, PayrollBucket> = {
  present: 'present',
  late: 'present',
  wfh: 'present',
  comp_off: 'present',
  half_day: 'half',
  absent: 'absent',
  leave: 'paidLeave',
  holiday: 'holiday',
  weekoff: 'weekoff',
};

export function bucketForStatus(status: string): PayrollBucket {
  return BUCKET[status] ?? 'none';
}
