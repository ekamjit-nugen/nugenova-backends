import {
  computePF,
  computeESI,
  computePT,
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

describe('computeStatutory', () => {
  it('aggregates PF + ESI + PT into employee deductions + employer contributions', () => {
    // basic 20000 (PF capped at 15000), gross 20000 (ESI applies), MH, June
    const r = computeStatutory(20000, 20000, 6, DEFAULT_STATUTORY_CONFIG);
    expect(r.pfEmployee).toBe(1800);
    expect(r.pfEmployer).toBe(1800);
    expect(r.esiEmployee).toBe(150);
    expect(r.professionalTax).toBe(200);
    expect(r.employeeDeductions).toBe(1800 + 150 + 200);
    expect(r.employerContributions).toBe(1800 + 650);
  });
});
