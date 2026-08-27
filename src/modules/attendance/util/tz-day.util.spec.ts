import {
  DEFAULT_TZ,
  tzOffsetMinutes,
  tzCalendarParts,
  dayBoundsUtc,
  dayAnchorUtc,
  dayKeyInTz,
  monthBoundsUtc,
  weekdayNameInTz,
} from './tz-day.util';

/**
 * G-X3 — timezone-aware day anchoring. The property under test: a record's day
 * key is the ORG-LOCAL calendar day, never the container's UTC day, so a
 * past-midnight clock-in buckets correctly and the unique (org, emp, day) index
 * holds.
 */
describe('tz-day.util (G-X3)', () => {
  const IST = 'Asia/Kolkata';

  it('reports the tz offset in minutes east of UTC', () => {
    expect(tzOffsetMinutes(IST, new Date('2026-04-23T10:00:00Z'))).toBe(330);
    expect(tzOffsetMinutes('UTC', new Date('2026-04-23T10:00:00Z'))).toBe(0);
  });

  it('resolves a morning clock-in to the same calendar day', () => {
    // 09:30 IST on 2026-04-23 = 04:00 UTC same date.
    expect(dayKeyInTz(new Date('2026-04-23T04:00:00Z'), IST)).toBe('2026-04-23');
  });

  it('INV-TZ-1: a past-midnight clock-in belongs to the local day, not the UTC day', () => {
    // 02:00 IST on 2026-04-23 = 20:30 UTC on 2026-04-22.
    const at = new Date('2026-04-22T20:30:00Z');
    expect(dayKeyInTz(at, IST)).toBe('2026-04-23');
    // In UTC the same instant is the 22nd — proving the tz math matters.
    expect(at.getUTCDate()).toBe(22);
  });

  it('day bounds cover the whole local day as a UTC-anchored range', () => {
    const { start, end, anchor } = dayBoundsUtc(new Date('2026-04-22T20:30:00Z'), IST);
    expect(start.toISOString()).toBe('2026-04-23T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-04-23T23:59:59.999Z');
    expect(anchor.getTime()).toBe(start.getTime());
  });

  it('computes the previous local day with calendar arithmetic', () => {
    expect(dayKeyInTz(new Date('2026-03-01T04:00:00Z'), IST, -1)).toBe('2026-02-28');
  });

  it('anchors the month bounds to the org-tz calendar month', () => {
    const { start, end } = monthBoundsUtc(new Date('2026-02-15T04:00:00Z'), IST);
    expect(start.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-02-28T23:59:59.999Z');
  });

  it('names the weekday of the org-tz day', () => {
    expect(weekdayNameInTz(new Date('2026-04-23T04:00:00Z'), IST)).toBe('thursday');
  });

  it('falls back without throwing for an invalid timezone', () => {
    expect(() => tzCalendarParts(new Date(), 'Not/AZone')).not.toThrow();
    expect(tzOffsetMinutes('Not/AZone', new Date())).toBe(0);
    expect(dayAnchorUtc(new Date('2026-04-23T10:00:00Z'), 'Not/AZone')).toBeInstanceOf(Date);
  });

  it('exposes IST as the default tz', () => {
    expect(DEFAULT_TZ).toBe('Asia/Kolkata');
  });
});
