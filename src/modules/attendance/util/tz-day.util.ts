/**
 * Timezone-aware day math for attendance (G-X3).
 *
 * The attendance system anchors every record to a CALENDAR DAY. That day
 * must be resolved in the organization's timezone, not the container's
 * (which is UTC in Docker) — otherwise a clock-in at 02:00 IST (20:30 UTC the
 * previous day) is bucketed into the wrong day, and a clock-out that crosses
 * UTC midnight can't find its open session.
 *
 * Backward-compatibility: the day ANCHOR returned here is a UTC-midnight
 * `Date` (same storage shape as the Mongo `date` field it was ported from)
 * whose Y/M/D equal the org-tz calendar date. So records keep their format
 * while correctly reflecting the org-local day. Calendar arithmetic (delta
 * days) is done on the extracted Y/M/D via `Date.UTC`, which normalises
 * month/year rollover and is timezone-sign agnostic.
 *
 * Ported verbatim from the Nugenova monolith (attendance/util/tz-day.util.ts) —
 * a pure function module with no datastore coupling.
 */

export const DEFAULT_TZ = 'Asia/Kolkata';

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Minutes the IANA timezone is offset from UTC at a given instant.
 * Positive east (Asia/Kolkata → +330). DST-aware (Intl handles it).
 * Falls back to 0 (UTC) for an invalid timezone rather than throwing.
 */
export function tzOffsetMinutes(tz: string, at: Date): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);
    const m: Record<string, string> = {};
    for (const p of parts) m[p.type] = p.value;
    const hour = m.hour === '24' ? '00' : m.hour;
    const asUtc = Date.UTC(
      Number(m.year),
      Number(m.month) - 1,
      Number(m.day),
      Number(hour),
      Number(m.minute),
      Number(m.second),
    );
    return Math.round((asUtc - at.getTime()) / 60_000);
  } catch {
    return 0;
  }
}

/** The org-tz calendar date (year, month 1-12, day) of instant `at`. */
export function tzCalendarParts(
  at: Date,
  tz: string,
): { year: number; month: number; day: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(at);
    const m: Record<string, string> = {};
    for (const p of parts) m[p.type] = p.value;
    return { year: Number(m.year), month: Number(m.month), day: Number(m.day) };
  } catch {
    // Invalid tz → fall back to UTC calendar parts so callers never crash.
    return {
      year: at.getUTCFullYear(),
      month: at.getUTCMonth() + 1,
      day: at.getUTCDate(),
    };
  }
}

/**
 * Day bounds for the org-tz day `deltaDays` away from the day containing `at`.
 * Returns UTC-midnight-anchored start/end (and `anchor` === `start`).
 */
export function dayBoundsUtc(
  at: Date,
  tz: string,
  deltaDays = 0,
): { start: Date; end: Date; anchor: Date } {
  const { year, month, day } = tzCalendarParts(at, tz);
  // Date.UTC normalises day+delta across month/year boundaries.
  const start = new Date(Date.UTC(year, month - 1, day + deltaDays, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month - 1, day + deltaDays, 23, 59, 59, 999));
  return { start, end, anchor: start };
}

/**
 * UTC-midnight `Date` whose Y/M/D equal the org-tz calendar date of `at`
 * (optionally shifted by `deltaDays`). This is the value stored in `date`.
 */
export function dayAnchorUtc(at: Date, tz: string, deltaDays = 0): Date {
  return dayBoundsUtc(at, tz, deltaDays).anchor;
}

/** 'YYYY-MM-DD' for the org-tz day (optionally shifted) containing `at`. */
export function dayKeyInTz(at: Date, tz: string, deltaDays = 0): string {
  const a = dayAnchorUtc(at, tz, deltaDays);
  return `${a.getUTCFullYear()}-${pad2(a.getUTCMonth() + 1)}-${pad2(a.getUTCDate())}`;
}

/** UTC-midnight-anchored bounds of the org-tz CALENDAR MONTH containing `at`. */
export function monthBoundsUtc(at: Date, tz: string): { start: Date; end: Date } {
  const { year, month } = tzCalendarParts(at, tz);
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  // Day 0 of next month = last day of this month.
  const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
  return { start, end };
}

/** Lowercase full weekday name (e.g. "monday") for the org-tz day of `at`. */
export function weekdayNameInTz(at: Date, tz: string): string {
  const anchor = dayAnchorUtc(at, tz);
  return ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][
    anchor.getUTCDay()
  ];
}
