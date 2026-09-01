import { computeAnnualTax, computeMonthlyTds, fyMonthIndex, slabTax, NEW_REGIME } from './tds';

describe('slabTax (new regime)', () => {
  it('is zero up to the first slab', () => {
    expect(slabTax(400000, NEW_REGIME.slabs)).toBe(0);
  });
  it('sums progressive bands', () => {
    // 20L: 5%*4L + 10%*4L + 15%*4L + 20%*4L = 20k+40k+60k+80k
    expect(slabTax(2000000, NEW_REGIME.slabs)).toBe(200000);
  });
});

describe('computeAnnualTax — new regime', () => {
  it('is zero up to the ₹12L rebate limit', () => {
    expect(computeAnnualTax(1200000, 'new')).toBe(0);
    expect(computeAnnualTax(700000, 'new')).toBe(0);
  });
  it('applies marginal relief just above ₹12L', () => {
    // slab tax at 12.1L = 61,500 but tax is capped at income over 12L = 10,000; +4% cess.
    expect(computeAnnualTax(1210000, 'new')).toBe(10400);
  });
  it('taxes ₹20L with 4% cess and no surcharge', () => {
    // 200,000 tax + 8,000 cess
    expect(computeAnnualTax(2000000, 'new')).toBe(208000);
  });
  it('adds 10% surcharge above ₹50L', () => {
    // 60L: slab 1,380,000 + 10% surcharge 138,000 + 4% cess 60,720
    expect(computeAnnualTax(6000000, 'new')).toBe(1578720);
  });
});

describe('computeAnnualTax — old regime', () => {
  it('is zero up to the ₹5L rebate limit', () => {
    expect(computeAnnualTax(500000, 'old')).toBe(0);
  });
  it('taxes ₹10L (no rebate, no marginal relief)', () => {
    // 5%*2.5L + 20%*5L = 12,500 + 100,000 = 112,500 + 4% cess 4,500
    expect(computeAnnualTax(1000000, 'old')).toBe(117000);
  });
});

describe('fyMonthIndex', () => {
  it('runs Apr=1 … Mar=12', () => {
    expect(fyMonthIndex(4)).toBe(1);
    expect(fyMonthIndex(9)).toBe(6);
    expect(fyMonthIndex(3)).toBe(12);
  });
});

describe('computeMonthlyTds', () => {
  it('spreads the annual tax over the remaining FY months', () => {
    // April (12 months left), nothing withheld yet → annual/12.
    const r = computeMonthlyTds({ annualTaxable: 2000000, regime: 'new', month: 4, tdsPaidYtd: 0 });
    expect(r.annualTax).toBe(208000);
    expect(r.monthly).toBe(Math.round(208000 / 12)); // 17333
  });
  it('trues up in the last month against what was already withheld', () => {
    // March (1 month left): withhold the balance.
    const r = computeMonthlyTds({ annualTaxable: 2000000, regime: 'new', month: 3, tdsPaidYtd: 190000 });
    expect(r.monthly).toBe(18000);
  });
  it('never withholds a negative amount', () => {
    const r = computeMonthlyTds({ annualTaxable: 2000000, regime: 'new', month: 3, tdsPaidYtd: 999999 });
    expect(r.monthly).toBe(0);
  });
});
