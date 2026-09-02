import { buildForm16PartB, fyLabel, fyQuarter, Form16Inputs } from './form16';
import { computeAnnualTax } from './tds';

function inputs(over: Partial<Form16Inputs> = {}): Form16Inputs {
  return {
    fyStart: 2025,
    regime: 'old',
    grossSalary: 1500000,
    section10Exemptions: 0,
    homeLoanInterest: 0,
    chapterVIA: { section80C: 0, section80D: 0, section80E: 0, other: 0 },
    tdsDeducted: 0,
    quarterlyTds: { q1: 0, q2: 0, q3: 0, q4: 0 },
    ...over,
  };
}

describe('fyLabel / fyQuarter', () => {
  it('labels the FY and AY', () => {
    expect(fyLabel(2025)).toBe('2025-26');
    expect(fyLabel(2026)).toBe('2026-27');
  });
  it('maps months to FY quarters', () => {
    expect(fyQuarter(4)).toBe('q1');
    expect(fyQuarter(6)).toBe('q1');
    expect(fyQuarter(9)).toBe('q2');
    expect(fyQuarter(12)).toBe('q3');
    expect(fyQuarter(1)).toBe('q4');
    expect(fyQuarter(3)).toBe('q4');
  });
});

describe('buildForm16PartB — old regime', () => {
  it('applies std deduction, home-loan cap, Chapter VI-A and computes tax', () => {
    const f = buildForm16PartB(inputs({
      grossSalary: 1500000,
      section10Exemptions: 100000,
      homeLoanInterest: 250000, // capped to 200000
      chapterVIA: { section80C: 200000 /* cap 150000 */, section80D: 25000, section80E: 0, other: 0 },
    }));
    expect(f.standardDeduction).toBe(50000);
    expect(f.netSalary).toBe(1500000 - 100000 - 50000); // 1,350,000
    expect(f.homeLoanInterest).toBe(200000); // capped
    expect(f.grossTotalIncome).toBe(1350000 - 200000); // 1,150,000
    expect(f.chapterVIA.section80C).toBe(150000); // capped
    expect(f.chapterVIA.total).toBe(150000 + 25000); // 175,000
    expect(f.taxableIncome).toBe(1150000 - 175000); // 975,000
    expect(f.taxPayable).toBe(computeAnnualTax(975000, 'old'));
    expect(f.assessmentYear).toBe('2026-27');
  });

  it('reports the balance = tax payable − TDS deducted', () => {
    const f = buildForm16PartB(inputs({ tdsDeducted: 50000 }));
    expect(f.balance).toBe(f.taxPayable - 50000);
    expect(f.tdsDeducted).toBe(50000);
  });
});

describe('buildForm16PartB — new regime', () => {
  it('ignores §10 / home-loan / Chapter VI-A and uses the ₹75k std deduction', () => {
    const f = buildForm16PartB(inputs({
      regime: 'new',
      grossSalary: 1500000,
      section10Exemptions: 100000,
      homeLoanInterest: 200000,
      chapterVIA: { section80C: 150000, section80D: 25000, section80E: 0, other: 0 },
    }));
    expect(f.standardDeduction).toBe(75000);
    expect(f.section10Exemptions).toBe(0);
    expect(f.homeLoanInterest).toBe(0);
    expect(f.chapterVIA.total).toBe(0);
    expect(f.taxableIncome).toBe(1500000 - 75000); // 1,425,000
    expect(f.taxPayable).toBe(computeAnnualTax(1425000, 'new'));
  });
});

describe('buildForm16PartB — tax breakdown exposed', () => {
  it('carries slab tax, rebate, surcharge and cess', () => {
    const f = buildForm16PartB(inputs({ regime: 'new', grossSalary: 1200000 }));
    // taxable 1,125,000 (< rebate limit 1.2M) → tax after rebate 0.
    expect(f.taxableIncome).toBe(1125000);
    expect(f.tax.taxAfterRebate).toBe(0);
    expect(f.taxPayable).toBe(0);
  });
});
