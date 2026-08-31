/**
 * Leave day-counting. Counts inclusive business days between two day boundaries,
 * excluding weekends AND org holidays. (Legacy Nugenova counted Mon–Fri but did
 * NOT exclude holidays — Nexora has a holiday calendar, so we use it.)
 *
 * A half-day request is always 0.5 and is only valid for a single day
 * (start === end) — that's enforced by the caller; here half-day short-circuits.
 */

/** UTC calendar-day key `YYYY-MM-DD` for a date. */
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface CountLeaveDaysInput {
  start: Date;
  end: Date;
  halfDay: boolean;
  /** UTC `YYYY-MM-DD` keys of org holidays that fall in the range. */
  holidays?: Set<string>;
}

/**
 * Inclusive business days in [start, end], minus weekends and holidays.
 * Returns 0.5 for a half-day. Returns 0 if the range is inverted or contains no
 * working days.
 */
export function countLeaveDays(input: CountLeaveDaysInput): number {
  if (input.halfDay) return 0.5;
  const start = startOfUtcDay(input.start);
  const end = startOfUtcDay(input.end);
  if (end.getTime() < start.getTime()) return 0;
  const holidays = input.holidays ?? new Set<string>();
  let days = 0;
  for (
    let t = start.getTime();
    t <= end.getTime();
    t += 24 * 60 * 60 * 1000
  ) {
    const d = new Date(t);
    const dow = d.getUTCDay(); // 0 Sun … 6 Sat
    if (dow === 0 || dow === 6) continue;
    if (holidays.has(dayKey(d))) continue;
    days += 1;
  }
  return days;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Do two inclusive day ranges overlap? */
export function rangesOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() <= bEnd.getTime() && bStart.getTime() <= aEnd.getTime();
}
