/**
 * When an open clock session still belongs to the shift that opened it.
 *
 * A shift that wraps midnight (16:30 → 01:30) is clocked out on the NEXT
 * calendar day, so a lookup anchored to "today" can never find the session that
 * is still running. Every clock action has to be able to reach back one org-day
 * for those employees — but only while the session is plausibly still running,
 * or a clock-out days later would record a shift that never happened.
 *
 * The bound is the same staleness threshold the reconcile cron uses, so the two
 * agree by construction: anything the cron would have auto-closed is no longer
 * claimable by a clock-out, and anything still claimable is something the cron
 * has not touched. Keeping one constant is the point — two numbers here would
 * drift into a window where neither path owns the session.
 */

/** Hours an open session may run before it counts as a missed checkout. */
export const STALE_OPEN_HOURS = 18;

/**
 * Is `openedAt` still the session you are clocking out of at `now`?
 *
 * False for a session already past the staleness threshold (the cron owns that
 * one) and for a clock-out that predates its own clock-in, which would compute
 * negative hours.
 */
export function isSessionStillRunning(
  openedAt: Date,
  now: Date,
  staleHours: number = STALE_OPEN_HOURS,
): boolean {
  const elapsedMs = now.getTime() - openedAt.getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return false;
  return elapsedMs <= staleHours * 3_600_000;
}
