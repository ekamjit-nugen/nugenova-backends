import { STALE_OPEN_HOURS, isSessionStillRunning } from './session-window';

/**
 * The boundary matters: it is the handover between the employee's own clock-out
 * and the reconcile cron. A gap would strand a session neither path will close;
 * an overlap would let a clock-out and the cron both write one.
 */
describe('isSessionStillRunning', () => {
  const now = new Date('2026-09-18T02:00:00.000Z');
  const hoursBefore = (h: number) => new Date(now.getTime() - h * 3_600_000);

  it('claims a session opened a few hours ago', () => {
    expect(isSessionStillRunning(hoursBefore(3), now)).toBe(true);
  });

  it('claims a night shift that has run most of the night', () => {
    expect(isSessionStillRunning(hoursBefore(9), now)).toBe(true);
  });

  it('claims a session exactly at the threshold', () => {
    expect(isSessionStillRunning(hoursBefore(STALE_OPEN_HOURS), now)).toBe(true);
  });

  it('releases a session past the threshold to the cron', () => {
    expect(isSessionStillRunning(hoursBefore(STALE_OPEN_HOURS + 0.01), now)).toBe(false);
  });

  it('releases a session left open for days', () => {
    expect(isSessionStillRunning(hoursBefore(72), now)).toBe(false);
  });

  it('refuses a clock-out that predates its own clock-in', () => {
    // Clock skew or a bad seed; closing it would compute negative hours.
    expect(isSessionStillRunning(new Date(now.getTime() + 60_000), now)).toBe(false);
  });

  it('refuses an unparseable clock-in rather than treating it as current', () => {
    expect(isSessionStillRunning(new Date('nonsense'), now)).toBe(false);
  });
});
