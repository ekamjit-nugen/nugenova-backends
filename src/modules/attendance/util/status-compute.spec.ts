import {
  DEFAULT_WORK_TIMING,
  WorkTiming,
  computeShiftStatusFields,
  detectNightShiftWindow,
  expectedStartInTz,
} from './status-compute';

/**
 * G-C4 / G-P4 — policy-driven status derivation. Uses the default IST 09:00
 * work-timing (the monolith fallback) unless a scenario overrides it.
 */
describe('status-compute (G-C4)', () => {
  const wt = DEFAULT_WORK_TIMING; // 09:00 IST, grace 15, min 8h

  // Helper: an instant at HH:MM IST on 2026-04-23 → the UTC Date to pass in.
  const istAt = (h: number, m: number) => {
    // IST = UTC+5:30, so UTC hour = h-5, minute = m-30 (borrow as needed).
    const utcMs = Date.UTC(2026, 3, 23, h, m, 0) - 330 * 60_000;
    return new Date(utcMs);
  };

  it('an on-time clock-in is present', () => {
    const r = computeShiftStatusFields(wt, istAt(9, 5));
    expect(r.status).toBe('present');
    expect(r.isLateArrival).toBe(false);
  });

  it('within grace is still present', () => {
    const r = computeShiftStatusFields(wt, istAt(9, 15));
    expect(r.status).toBe('present');
    expect(r.isLateArrival).toBe(false);
  });

  it('late beyond grace but under the half-day threshold is late', () => {
    // 09:25 → 25 min late, 10 beyond the 15-min grace, < 30 → late.
    const r = computeShiftStatusFields(wt, istAt(9, 25));
    expect(r.status).toBe('late');
    expect(r.isLateArrival).toBe(true);
    expect(r.lateByMinutes).toBe(25);
  });

  it('late beyond the half-day threshold is half_day', () => {
    // 09:50 → 50 min late, 35 beyond grace, ≥ 30 → half_day.
    const r = computeShiftStatusFields(wt, istAt(9, 50));
    expect(r.status).toBe('half_day');
  });

  it('worked below minHoursForPresent demotes to half_day even when on time', () => {
    const r = computeShiftStatusFields(wt, istAt(9, 0), 3); // 3h < default 4h
    expect(r.status).toBe('half_day');
  });

  it('a full on-time day with enough hours is present', () => {
    const r = computeShiftStatusFields(wt, istAt(9, 0), 8.5);
    expect(r.status).toBe('present');
    expect(r.isEarlyDeparture).toBe(false);
  });

  it('flags early departure when worked hours fall short', () => {
    const r = computeShiftStatusFields(wt, istAt(9, 0), 6); // 2h short of 8
    expect(r.isEarlyDeparture).toBe(true);
    expect(r.earlyByMinutes).toBe(120);
  });

  it('returns the safe fallback when no work-timing resolves', () => {
    const r = computeShiftStatusFields(null, new Date());
    expect(r.status).toBe('present');
    expect(r.isLateArrival).toBe(false);
  });

  it('detects a midnight-wrapping window as a night shift', () => {
    expect(detectNightShiftWindow('22:00', '06:00')).toBe(true);
    expect(detectNightShiftWindow('09:00', '18:00')).toBe(false);
  });

  it('expectedStartInTz resolves 09:00 IST to the right UTC instant (no container drift)', () => {
    const start = expectedStartInTz(istAt(20, 0), 9, 0, 'Asia/Kolkata');
    // 09:00 IST on 2026-04-23 = 03:30 UTC.
    expect(start.toISOString()).toBe('2026-04-23T03:30:00.000Z');
  });

  it('honours a custom lateToHalfDay threshold', () => {
    const strict: WorkTiming = { ...wt, lateToHalfDayMinutes: 10 };
    // 09:30 → 30 late, 15 beyond grace, ≥ 10 → half_day under the strict policy.
    expect(computeShiftStatusFields(strict, istAt(9, 30)).status).toBe('half_day');
  });
});
