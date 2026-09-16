import { normalizeSkill, scoreMatch, type MatchCandidate } from './matching';
import { checkTransition, costPerUnitFromAnnual, marginPct, SUBMISSION_TRANSITIONS } from './submission-rules';

const base: MatchCandidate = {
  skills: ['Python', 'PySpark', 'SQL', 'Airflow'], totalExpMonths: 72, noticePeriodDays: 30, noticeStatus: 'fixed',
  currentLocation: 'Noida', preferredLocations: ['Mohali'], status: 'active',
};

describe('matching', () => {
  const now = new Date('2026-09-15T00:00:00Z');

  it('normalises skill aliases', () => {
    expect(normalizeSkill('Spark')).toBe('pyspark');
    expect(normalizeSkill('PowerBI')).toBe('power bi');
    expect(normalizeSkill(' ReactJS ')).toBe('react');
  });

  it('scores a strong fit high with reasons', () => {
    const r = scoreMatch(base, { skills: ['spark', 'sql', 'airflow'], expMinYears: 5, expMaxYears: 8, location: 'Mohali', neededBy: '2026-10-30' }, now)!;
    expect(r.score).toBe(100);
    expect(r.matchedSkills).toEqual(['pyspark', 'sql', 'airflow']);
    expect(r.reasons.join(' | ')).toMatch(/3\/3 skills.*6 yrs fits 5–8.*Can join in 30d.*Location fits Mohali/);
  });

  it('penalises skills gap, experience gap, late notice and location', () => {
    const r = scoreMatch(
      { ...base, skills: ['Java'], totalExpMonths: 24, noticePeriodDays: 90, preferredLocations: [] },
      { skills: ['pyspark', 'sql'], expMinYears: 6, location: 'Pune', neededBy: '2026-09-25' }, now,
    )!;
    expect(r.score).toBeLessThan(15);
    expect(r.reasons).toContain('No matching skills');
  });

  it('is neutral when data is missing and excludes blacklisted', () => {
    const r = scoreMatch({ ...base, skills: [], totalExpMonths: null, noticePeriodDays: null, noticeStatus: 'unknown', currentLocation: null, preferredLocations: [] }, { skills: ['sql'] }, now)!;
    expect(r.score).toBe(15 + 10 + 5 + 5);
    expect(scoreMatch({ ...base, status: 'blacklisted' }, { skills: [] }, now)).toBeNull();
  });

  it('remote roles ignore location; immediate joiners get full notice credit', () => {
    const r = scoreMatch({ ...base, noticeStatus: 'immediate', noticePeriodDays: null, currentLocation: 'Chennai', preferredLocations: [] }, { skills: ['sql'], workMode: 'remote', location: 'Remote', neededBy: '2026-09-16' }, now)!;
    expect(r.reasons).toContain('Immediate joiner');
    expect(r.score).toBe(Math.round((1 / 1) * 60) + 10 + 10 + 10);
  });
});

describe('submission rules', () => {
  it('enforces the transition map and reasons', () => {
    expect(checkTransition('shortlisted', 'submitted')).toEqual({ ok: true });
    expect(checkTransition('shortlisted', 'onboarded').ok).toBe(false);
    expect(checkTransition('submitted', 'client_rejected').ok).toBe(false);
    expect(checkTransition('submitted', 'client_rejected', 'Budget mismatch')).toEqual({ ok: true });
    expect(checkTransition('client_selected', 'client_selected').ok).toBe(false);
    expect(SUBMISSION_TRANSITIONS.onboarded).toEqual([]);
  });

  it('derives cost per unit and margin', () => {
    expect(costPerUnitFromAnnual(2_520_000, 'month')).toBe(210_000);
    expect(costPerUnitFromAnnual(2_520_000, 'day')).toBe(10_000);
    expect(costPerUnitFromAnnual(2_520_000, 'hour')).toBe(1_250);
    expect(costPerUnitFromAnnual(null, 'hour')).toBeNull();
    expect(marginPct(2000, 1250)).toBe(37.5);
    expect(marginPct(null, 1)).toBeNull();
  });
});
