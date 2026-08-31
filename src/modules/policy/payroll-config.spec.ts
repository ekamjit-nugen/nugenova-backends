import {
  defaultPayrollConfig,
  resolvePayrollConfig,
  sanitizePayrollConfig,
  ptStateOptions,
} from './payroll-config';

describe('resolvePayrollConfig', () => {
  it('returns the defaults for null/empty input', () => {
    const d = defaultPayrollConfig();
    expect(resolvePayrollConfig(null)).toEqual(d);
    expect(resolvePayrollConfig({})).toEqual(d);
  });

  it('fills missing fields from the defaults', () => {
    const r = resolvePayrollConfig({ pf: { enabled: false } });
    expect(r.pf.enabled).toBe(false);
    expect(r.pf.employeeRate).toBe(12); // default preserved
    expect(r.esi.enabled).toBe(true);
    expect(r.ptState).toBe('MH');
  });

  it('clamps out-of-range rates and rounds ceilings', () => {
    const r = resolvePayrollConfig({
      pf: { employeeRate: 999, wageCeiling: 15000.7 },
      esi: { employeeRate: -5 },
    });
    expect(r.pf.employeeRate).toBe(100); // clamped to max
    expect(r.pf.wageCeiling).toBe(15001); // rounded
    expect(r.esi.employeeRate).toBe(0); // clamped to min
  });

  it('rejects an unknown PT state, falling back to the default', () => {
    expect(resolvePayrollConfig({ ptState: 'ZZ' }).ptState).toBe('MH');
    expect(resolvePayrollConfig({ ptState: 'KA' }).ptState).toBe('KA');
    expect(resolvePayrollConfig({ ptState: 'none' }).ptState).toBe('none');
  });

  it('does not mutate the shared default object', () => {
    const a = resolvePayrollConfig({ pf: { employeeRate: 5 } });
    const b = defaultPayrollConfig();
    expect(b.pf.employeeRate).toBe(12);
    expect(a.pf.employeeRate).toBe(5);
  });
});

describe('sanitizePayrollConfig', () => {
  it('produces a fully-resolved config (same as resolve)', () => {
    expect(sanitizePayrollConfig({ ptState: 'none' })).toEqual(
      resolvePayrollConfig({ ptState: 'none' }),
    );
  });
});

describe('ptStateOptions', () => {
  it('includes none + Maharashtra with labels', () => {
    const opts = ptStateOptions();
    expect(opts.find((o) => o.value === 'none')).toBeTruthy();
    expect(opts.find((o) => o.value === 'MH')?.label).toBe('Maharashtra');
  });
});
