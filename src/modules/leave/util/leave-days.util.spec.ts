import { countLeaveDays, rangesOverlap, dayKey } from './leave-days.util';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe('countLeaveDays', () => {
  it('counts a single weekday as 1', () => {
    // 2026-09-01 is a Tuesday
    expect(countLeaveDays({ start: d('2026-09-01'), end: d('2026-09-01'), halfDay: false })).toBe(1);
  });

  it('excludes weekends across a range', () => {
    // Mon 2026-09-07 .. Fri 2026-09-11 = 5; add the weekend, still 5
    expect(countLeaveDays({ start: d('2026-09-07'), end: d('2026-09-13'), halfDay: false })).toBe(5);
  });

  it('returns 0 for a pure weekend', () => {
    // Sat 2026-09-12 .. Sun 2026-09-13
    expect(countLeaveDays({ start: d('2026-09-12'), end: d('2026-09-13'), halfDay: false })).toBe(0);
  });

  it('excludes holidays that fall on weekdays', () => {
    const holidays = new Set(['2026-09-08']); // a Tuesday
    expect(
      countLeaveDays({ start: d('2026-09-07'), end: d('2026-09-11'), halfDay: false, holidays }),
    ).toBe(4);
  });

  it('a half-day is always 0.5', () => {
    expect(countLeaveDays({ start: d('2026-09-01'), end: d('2026-09-01'), halfDay: true })).toBe(0.5);
  });

  it('returns 0 for an inverted range', () => {
    expect(countLeaveDays({ start: d('2026-09-10'), end: d('2026-09-01'), halfDay: false })).toBe(0);
  });
});

describe('rangesOverlap', () => {
  it('detects overlapping ranges', () => {
    expect(rangesOverlap(d('2026-09-01'), d('2026-09-05'), d('2026-09-04'), d('2026-09-08'))).toBe(true);
  });
  it('detects touching ranges as overlapping (same day)', () => {
    expect(rangesOverlap(d('2026-09-01'), d('2026-09-05'), d('2026-09-05'), d('2026-09-09'))).toBe(true);
  });
  it('separate ranges do not overlap', () => {
    expect(rangesOverlap(d('2026-09-01'), d('2026-09-05'), d('2026-09-06'), d('2026-09-09'))).toBe(false);
  });
});

describe('dayKey', () => {
  it('formats a UTC day key', () => {
    expect(dayKey(new Date('2026-09-01T18:30:00.000Z'))).toBe('2026-09-01');
  });
});
