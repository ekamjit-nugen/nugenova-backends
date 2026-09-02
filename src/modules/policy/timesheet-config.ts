/**
 * Timesheet policy — whether employees submit timesheets, and how often (weekly
 * or monthly). Stored on a `timesheet`-category policy row in
 * `extraConfig.timesheet`. Mirrors the leave/payroll-config pattern.
 */

export type TimesheetCadence = 'weekly' | 'monthly';

export interface TimesheetConfig {
  /** Are timesheets required at all? */
  enabled: boolean;
  /** Submit a timesheet every week or every month. */
  cadence: TimesheetCadence;
  /** Employees may edit the auto-filled hours (from attendance) before submitting. */
  allowEdits: boolean;
}

export interface TimesheetConfigInput {
  enabled?: boolean;
  cadence?: string;
  allowEdits?: boolean;
}

export function defaultTimesheetConfig(): TimesheetConfig {
  // Off by default (opt-in), monthly when turned on.
  return { enabled: false, cadence: 'monthly', allowEdits: true };
}

const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);

export function resolveTimesheetConfig(stored: TimesheetConfigInput | null | undefined): TimesheetConfig {
  const d = defaultTimesheetConfig();
  const s = stored || {};
  return {
    enabled: bool(s.enabled, d.enabled),
    cadence: s.cadence === 'weekly' ? 'weekly' : s.cadence === 'monthly' ? 'monthly' : d.cadence,
    allowEdits: bool(s.allowEdits, d.allowEdits),
  };
}

export function sanitizeTimesheetConfig(input: TimesheetConfigInput | null | undefined): TimesheetConfig {
  return resolveTimesheetConfig(input);
}
