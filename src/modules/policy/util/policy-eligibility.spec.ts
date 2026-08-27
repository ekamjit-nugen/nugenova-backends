import { isPolicyEffective, matchesApplicability } from './policy-eligibility';

/**
 * G-P3 / G-P7 — a policy applies only inside its effective window AND when its
 * applicability matches the employee. Pure-unit coverage of the resolver's core.
 */
describe('policy-eligibility', () => {
  const now = new Date('2026-06-15T06:00:00Z');

  describe('isPolicyEffective (G-P3)', () => {
    it('a policy with no dates is always effective', () => {
      expect(isPolicyEffective({}, now)).toBe(true);
    });

    it('a future-dated policy is not yet effective', () => {
      expect(isPolicyEffective({ effectiveFrom: '2026-07-01T00:00:00Z' }, now)).toBe(false);
    });

    it('an expired policy is no longer effective', () => {
      expect(isPolicyEffective({ effectiveTo: '2026-06-01T00:00:00Z' }, now)).toBe(false);
    });

    it('effectiveTo is inclusive to the end of its day (UTC)', () => {
      // Expires "on the 15th" → still effective at 06:00 UTC on the 15th.
      expect(isPolicyEffective({ effectiveTo: '2026-06-15T00:00:00Z' }, now)).toBe(true);
    });

    it('within the window it is effective', () => {
      expect(
        isPolicyEffective(
          { effectiveFrom: '2026-05-01T00:00:00Z', effectiveTo: '2026-07-01T00:00:00Z' },
          now,
        ),
      ).toBe(true);
    });
  });

  describe('matchesApplicability (G-P7)', () => {
    const emp = { _id: 'e1', departmentId: 'd1', designationId: 'g1' };

    it.each([
      ['all', [], true],
      ['specific', ['e1'], true],
      ['specific', ['e9'], false],
      ['department', ['d1'], true],
      ['department', ['d9'], false],
      ['designation', ['g1'], true],
      ['designation', ['g9'], false],
    ])('applicableTo %s targeting %j → %s', (scope, ids, result) => {
      expect(
        matchesApplicability({ applicableTo: scope as string, applicableIds: ids as string[] }, emp),
      ).toBe(result);
    });

    it('a missing scope defaults to all', () => {
      expect(matchesApplicability({}, emp)).toBe(true);
    });
  });
});
