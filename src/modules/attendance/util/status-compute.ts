/**
 * Attendance status derivation (G-C4 / G-P4) — pure, policy-driven.
 *
 * Ported from the monolith's `AttendanceService.computeShiftStatusFields` +
 * `expectedStartInTz` + `detectNightShiftWindow`, extracted here as standalone
 * pure functions (no DB, no `this`) so both clock-in (hours unknown) and
 * clock-out (hours known) can call it, and so it's directly unit-testable.
 *
 * Until the Policy module is migrated, callers pass `DEFAULT_WORK_TIMING`
 * (09:00–18:00 IST, 15-min grace, 8h min) — which is exactly the monolith's
 * fallback when no policy resolves, so behaviour is unchanged.
 */
import { tzOffsetMinutes } from './tz-day.util';

export interface WorkTiming {
  startTime: string; // 'HH:MM'
  endTime: string; // 'HH:MM'
  timezone: string; // IANA, e.g. 'Asia/Kolkata'
  graceMinutes: number; // late tolerance before an arrival counts as late
  minWorkingHours: number; // full-day threshold (early-departure basis)
  breakMinutes: number; // unpaid break deducted from worked → effective
  lateToHalfDayMinutes: number | null; // late beyond this ⇒ half_day (default 30)
  minHoursForPresent: number | null; // worked below this ⇒ half_day (default 4)
  isNightShift: boolean;
}

/** The monolith's fallback work-timing — used until a Policy resolves. */
export const DEFAULT_WORK_TIMING: WorkTiming = {
  startTime: '09:00',
  endTime: '18:00',
  timezone: 'Asia/Kolkata',
  graceMinutes: 15,
  minWorkingHours: 8,
  breakMinutes: 60,
  lateToHalfDayMinutes: null,
  minHoursForPresent: null,
  isNightShift: false,
};

export interface ComputedStatusFields {
  isLateArrival: boolean;
  lateByMinutes: number;
  isEarlyDeparture: boolean;
  earlyByMinutes: number;
  status: 'present' | 'late' | 'half_day';
  isNightShift: boolean;
}

/**
 * `startTime > endTime` (HH:MM string compare) → the window wraps midnight.
 * Callers should still trust an explicit `isNightShift` flag first.
 */
export function detectNightShiftWindow(startTime?: string, endTime?: string): boolean {
  if (!startTime || !endTime) return false;
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  if (!Number.isFinite(sh) || !Number.isFinite(eh)) return false;
  const startMin = sh * 60 + (sm || 0);
  const endMin = eh * 60 + (em || 0);
  return endMin <= startMin;
}

/**
 * A UTC `Date` for the first moment of `startHH:startMM` on `checkInTime`'s
 * LOCAL calendar date in `tz`. Prevents the container-UTC drift where a
 * 09:00 Asia/Kolkata policy was compared against 09:00 UTC (5.5h off).
 */
export function expectedStartInTz(
  checkInTime: Date,
  startHH: number,
  startMM: number,
  tz: string,
): Date {
  try {
    const dateParts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(checkInTime);
    const dm: Record<string, string> = {};
    for (const p of dateParts) dm[p.type] = p.value;

    // Construct as if the tz wall-clock were UTC — a "naive" instant …
    const naiveUtcMs = Date.UTC(
      Number(dm.year),
      Number(dm.month) - 1,
      Number(dm.day),
      startHH,
      startMM,
      0,
    );
    // … then subtract the tz offset at that instant to get the real UTC time.
    const offsetMin = tzOffsetMinutes(tz, new Date(naiveUtcMs));
    return new Date(naiveUtcMs - offsetMin * 60_000);
  } catch {
    // Container-local fallback so a bad tz string never throws.
    const fallback = new Date(checkInTime);
    fallback.setHours(startHH, startMM, 0, 0);
    return fallback;
  }
}

/**
 * Resolve `isLateArrival` / `lateByMinutes` / `status` / `isNightShift` against
 * a policy's `workTiming`. Pure — safe to call at clock-in (`totalWorkingHours`
 * undefined) and clock-out (hours known, may demote to half_day).
 *
 * Layered status resolution:
 *   1. Worked < `minHoursForPresent` (default 4) → half_day (even if on time)
 *   2. Late beyond `lateToHalfDayMinutes` (default 30) → half_day
 *   3. Late beyond grace but under that threshold → late
 *   4. Otherwise → present
 */
export function computeShiftStatusFields(
  wt: WorkTiming | null,
  checkInTime: Date,
  totalWorkingHours?: number,
): ComputedStatusFields {
  const fallback: ComputedStatusFields = {
    isLateArrival: false,
    lateByMinutes: 0,
    isEarlyDeparture: false,
    earlyByMinutes: 0,
    status: 'present',
    isNightShift: false,
  };
  if (!wt || !wt.startTime) return fallback;

  const [sh, sm] = wt.startTime.split(':').map(Number);
  if (!Number.isFinite(sh) || !Number.isFinite(sm)) return fallback;

  const gracePadMin = wt.graceMinutes ?? 15;
  const lateToHalfDay = wt.lateToHalfDayMinutes ?? 30;
  const minHoursPresent = wt.minHoursForPresent ?? 4;
  const isNightShift =
    wt.isNightShift === true || detectNightShiftWindow(wt.startTime, wt.endTime);

  const tz = wt.timezone || 'Asia/Kolkata';
  let expectedStart = expectedStartInTz(checkInTime, sh, sm, tz);

  // Night shift clocked in well before start → reference yesterday's start so
  // lateByMinutes reflects "early to tonight's shift", not "ahead of tomorrow's".
  let lateMs = checkInTime.getTime() - expectedStart.getTime();
  if (isNightShift && lateMs < -12 * 3600_000) {
    expectedStart = new Date(expectedStart.getTime() - 24 * 3600_000);
    lateMs = checkInTime.getTime() - expectedStart.getTime();
  }

  const lateMinutesRaw = Math.round(lateMs / 60_000);
  const lateBeyondGrace = Math.max(0, lateMinutesRaw - gracePadMin);
  const isLate = lateBeyondGrace > 0;

  // Early departure only computable with clock-out data.
  let isEarly = false;
  let earlyMin = 0;
  if (typeof totalWorkingHours === 'number' && (wt.minWorkingHours ?? 8) > 0) {
    const shortfall = (wt.minWorkingHours ?? 8) - totalWorkingHours;
    if (shortfall > 0) {
      isEarly = true;
      earlyMin = Math.round(shortfall * 60);
    }
  }

  let status: 'present' | 'late' | 'half_day' = 'present';
  if (typeof totalWorkingHours === 'number' && totalWorkingHours < minHoursPresent) {
    status = 'half_day';
  } else if (lateBeyondGrace >= lateToHalfDay) {
    status = 'half_day';
  } else if (isLate) {
    status = 'late';
  }

  return {
    isLateArrival: isLate,
    lateByMinutes: isLate ? lateMinutesRaw : 0,
    isEarlyDeparture: isEarly,
    earlyByMinutes: earlyMin,
    status,
    isNightShift,
  };
}
