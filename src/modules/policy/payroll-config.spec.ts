import {
  defaultPayrollConfig,
  resolvePayrollConfig,
  sanitizePayrollConfig,
  ptStateOptions,
  lwfStateOptions,
} from './payroll-config';

describe('resolvePayrollConfig', () => {
  it('returns the defaults for null/empty input', () => {
    const d = defaultPayrollConfig();
    expect(resolvePayrollConfig(null)).toEqual(d);
    expect(resolvePayrollConfig({})).toEqual(d);
  });

  it('fills missing fields from the defaults (opt-in: flags off, rates present)', () => {
    const r = resolvePayrollConfig({ pf: { enabled: true } });
    expect(r.pf.enabled).toBe(true);
    expect(r.pf.employeeRate).toBe(12); // canonical rate still filled in
    expect(r.esi.enabled).toBe(false); // opt-in default: off until added
    expect(r.ptState).toBe('none');
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

  it('rejects an unknown PT state, falling back to the default (none)', () => {
    expect(resolvePayrollConfig({ ptState: 'ZZ' }).ptState).toBe('none');
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

describe('LWF config', () => {
  it('defaults LWF off with state none', () => {
    const r = resolvePayrollConfig({});
    expect(r.lwf).toEqual({ enabled: false, state: 'none' });
  });
  it('keeps a valid LWF state and rejects an invalid one', () => {
    expect(resolvePayrollConfig({ lwf: { enabled: true, state: 'MH' } }).lwf).toEqual({ enabled: true, state: 'MH' });
    expect(resolvePayrollConfig({ lwf: { enabled: true, state: 'ZZ' } }).lwf.state).toBe('none');
  });
});

describe('custom deductions', () => {
  it('normalises code, drops nameless/zero-value/dup/bad-code rows', () => {
    const r = resolvePayrollConfig({
      customDeductions: [
        { code: 'nps', name: 'NPS', basis: 'percent_basic', employeeValue: 10 },
        { code: 'INS', name: '', employeeValue: 200 }, // no name → dropped
        { code: 'ZERO', name: 'Zero', employeeValue: 0, employerValue: 0 }, // no value → dropped
        { code: 'NPS', name: 'Dup', employeeValue: 5 }, // dup code → dropped
        { code: 'bad code!', name: 'Bad', employeeValue: 5 }, // bad code → dropped
      ],
    });
    expect(r.customDeductions).toHaveLength(1);
    expect(r.customDeductions[0]).toMatchObject({ code: 'NPS', name: 'NPS', basis: 'percent_basic', employeeValue: 10, enabled: true });
  });
  it('clamps percent values to 100 and defaults an unknown basis to fixed', () => {
    const r = resolvePayrollConfig({
      customDeductions: [{ code: 'X', name: 'X', basis: 'percent_gross', employeeValue: 999 }],
    });
    expect(r.customDeductions[0].employeeValue).toBe(100);
    const r2 = resolvePayrollConfig({
      customDeductions: [{ code: 'Y', name: 'Y', basis: 'weird', employeeValue: 50 }],
    });
    expect(r2.customDeductions[0].basis).toBe('fixed');
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
  it('offers every Indian state/UT (36) plus the none option', () => {
    const opts = ptStateOptions();
    expect(opts).toHaveLength(37); // 28 states + 8 UTs + none
    // A state with no encoded PT slab is still selectable.
    expect(opts.find((o) => o.value === 'RJ')?.label).toBe('Rajasthan');
    expect(opts.find((o) => o.value === 'UP')?.label).toBe('Uttar Pradesh');
  });
});

describe('all-states validation', () => {
  it('accepts any Indian state for PT/LWF, even without a slab', () => {
    expect(resolvePayrollConfig({ ptState: 'RJ' }).ptState).toBe('RJ');
    expect(resolvePayrollConfig({ lwf: { enabled: true, state: 'UP' } }).lwf.state).toBe('UP');
  });
  it('LWF options also cover every state', () => {
    expect(lwfStateOptions()).toHaveLength(37);
  });
});
