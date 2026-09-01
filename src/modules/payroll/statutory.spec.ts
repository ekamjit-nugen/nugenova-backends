import {
  computePF,
  computeESI,
  computePT,
  computeLWF,
  evalCustomItem,
  computeStatutory,
  DEFAULT_STATUTORY_CONFIG,
} from './statutory';

describe('computePF', () => {
  const cfg = DEFAULT_STATUTORY_CONFIG.pf;
  it('caps the PF wage at the ceiling', () => {
    const pf = computePF(30000, cfg); // basic above the 15000 ceiling
    expect(pf.wage).toBe(15000);
    expect(pf.employee).toBe(1800); // 12% of 15000
    expect(pf.employer).toBe(1800);
  });
  it('uses actual basic below the ceiling', () => {
    const pf = computePF(10000, cfg);
    expect(pf.wage).toBe(10000);
    expect(pf.employee).toBe(1200);
  });
  it('is zero when disabled', () => {
    expect(computePF(30000, { ...cfg, enabled: false }).employee).toBe(0);
  });
  it('splits the employer share into EPS (capped ₹1250) + EPF above the ceiling', () => {
    const pf = computePF(30000, cfg); // EPS wage capped at 15000 → 8.33% = 1250
    expect(pf.eps).toBe(1250);
    expect(pf.epfEmployer).toBe(550); // 1800 employer − 1250 EPS
    expect(pf.eps + pf.epfEmployer).toBe(pf.employer);
  });
  it('splits EPS/EPF below the ceiling too', () => {
    const pf = computePF(10000, cfg); // EPS = 8.33% of 10000 = 833
    expect(pf.eps).toBe(833);
    expect(pf.epfEmployer).toBe(367); // 1200 − 833
    expect(pf.eps + pf.epfEmployer).toBe(pf.employer);
  });
});

describe('computeESI', () => {
  const cfg = DEFAULT_STATUTORY_CONFIG.esi;
  it('applies below the ceiling', () => {
    const esi = computeESI(20000, cfg);
    expect(esi.employee).toBe(150); // 0.75% of 20000
    expect(esi.employer).toBe(650); // 3.25% of 20000
  });
  it('is zero above the ceiling', () => {
    expect(computeESI(25000, cfg).employee).toBe(0);
  });
  it('decides coverage on the membership gross, charges on the earned gross', () => {
    // Heavy LOP: earned 15000, but full monthly gross 25000 > ceiling → NOT covered.
    expect(computeESI(15000, cfg, 25000).employee).toBe(0);
    // Full gross 20000 ≤ ceiling → covered; charged on the earned 10000 = 0.75%.
    expect(computeESI(10000, cfg, 20000).employee).toBe(75);
  });
});

describe('computePT', () => {
  it('Maharashtra top slab is 200, Feb is 300', () => {
    expect(computePT(50000, 'MH', 6)).toBe(200);
    expect(computePT(50000, 'MH', 2)).toBe(300);
  });
  it('Maharashtra below threshold is 0', () => {
    expect(computePT(7000, 'MH', 6)).toBe(0);
  });
  it('Karnataka is 200 above 25k, else 0', () => {
    expect(computePT(30000, 'KA', 6)).toBe(200);
    expect(computePT(20000, 'KA', 6)).toBe(0);
  });
  it('no-PT states resolve to zero', () => {
    expect(computePT(50000, 'none', 6)).toBe(0);
    expect(computePT(50000, 'DL', 6)).toBe(0); // unknown → none
  });
});

describe('computeLWF', () => {
  it('applies the state amounts only in the applicable months', () => {
    const cfg = { enabled: true, state: 'MH' }; // MH: 25/75 in June & December
    expect(computeLWF(cfg, 6)).toEqual({ employee: 25, employer: 75 });
    expect(computeLWF(cfg, 12)).toEqual({ employee: 25, employer: 75 });
    expect(computeLWF(cfg, 7)).toEqual({ employee: 0, employer: 0 });
  });
  it('is zero when disabled or state is none', () => {
    expect(computeLWF({ enabled: false, state: 'MH' }, 6).employee).toBe(0);
    expect(computeLWF({ enabled: true, state: 'none' }, 6).employee).toBe(0);
  });
});

describe('evalCustomItem', () => {
  const ctx = { gross: 50000, earnedGross: 40000, basic: 20000 };
  it('fixed amounts pass through on both sides', () => {
    const l = evalCustomItem(
      { code: 'INS', name: 'Insurance', enabled: true, basis: 'fixed', employeeValue: 200, employerValue: 300 },
      ctx,
    );
    expect(l).toEqual({ code: 'INS', name: 'Insurance', employee: 200, employer: 300 });
  });
  it('percent bases compute off the right figure', () => {
    expect(evalCustomItem({ code: 'A', name: 'A', enabled: true, basis: 'percent_gross', employeeValue: 10, employerValue: 0 }, ctx).employee).toBe(5000);
    expect(evalCustomItem({ code: 'B', name: 'B', enabled: true, basis: 'percent_earned_gross', employeeValue: 10, employerValue: 0 }, ctx).employee).toBe(4000);
    expect(evalCustomItem({ code: 'C', name: 'C', enabled: true, basis: 'percent_basic', employeeValue: 10, employerValue: 0 }, ctx).employee).toBe(2000);
  });
  it('a disabled item is zero', () => {
    expect(evalCustomItem({ code: 'X', name: 'X', enabled: false, basis: 'fixed', employeeValue: 500, employerValue: 0 }, ctx).employee).toBe(0);
  });
});

describe('computeStatutory', () => {
  it('aggregates PF + ESI + PT into employee deductions + employer contributions', () => {
    // basic 20000 (PF capped at 15000), gross 20000 (ESI applies), MH, June.
    // Default config has LWF disabled + no custom deductions.
    const r = computeStatutory(20000, 20000, 6, DEFAULT_STATUTORY_CONFIG);
    expect(r.pfEmployee).toBe(1800);
    expect(r.pfEmployer).toBe(1800);
    expect(r.esiEmployee).toBe(150);
    expect(r.professionalTax).toBe(200);
    expect(r.lwfEmployee).toBe(0);
    expect(r.employeeDeductions).toBe(1800 + 150 + 200);
    expect(r.employerContributions).toBe(1800 + 650);
  });

  it('folds LWF + custom deductions into the totals', () => {
    const cfg = {
      ...DEFAULT_STATUTORY_CONFIG,
      lwf: { enabled: true, state: 'MH' },
      customDeductions: [
        { code: 'NPS', name: 'NPS', enabled: true, basis: 'percent_basic' as const, employeeValue: 10, employerValue: 10 },
        { code: 'INS', name: 'Insurance', enabled: true, basis: 'fixed' as const, employeeValue: 200, employerValue: 0 },
      ],
    };
    // basic 15000, gross 30000 (ESI off, > ceiling), MH, June.
    const r = computeStatutory(15000, 30000, 6, cfg);
    expect(r.lwfEmployee).toBe(25);
    expect(r.lwfEmployer).toBe(75);
    expect(r.custom).toHaveLength(2);
    // employee: PF 1800 + ESI 0 + PT 200 + LWF 25 + NPS(10% of 15000=1500) + INS 200
    expect(r.employeeDeductions).toBe(1800 + 200 + 25 + 1500 + 200);
    // employer: PF 1800 + LWF 75 + NPS 1500
    expect(r.employerContributions).toBe(1800 + 75 + 1500);
  });
});
