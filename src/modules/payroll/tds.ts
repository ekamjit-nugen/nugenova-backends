/**
 * TDS (income-tax on salary) engine — pure, deterministic, unit-tested. Ported from
 * the legacy Nugenova income-tax service and India's FY 2025-26 (new + old regime)
 * rules. Amounts in RUPEES. The payroll run deducts monthly TDS = the projected
 * annual tax spread over the remaining months of the financial year, trued-up
 * against what has already been withheld (`tdsPaidYtd`).
 *
 * Slabs live as data (`NEW_REGIME`, `OLD_REGIME`) so a new FY is a data change.
 */

const round0 = (n: number) => Math.round(n);

export type TaxRegime = 'new' | 'old';

interface Slab {
  upTo: number; // inclusive upper bound of taxable income; Infinity for the top slab
  rate: number; // percent
}

/** Per-regime constants for the configured financial year. */
export interface RegimeSpec {
  slabs: Slab[];
  standardDeduction: number;
  /** Taxable income at/below which the §87A rebate wipes out the tax. */
  rebateLimit: number;
  /** Max §87A rebate amount. */
  rebateCap: number;
  /** Surcharge is capped at this % under the regime (new regime caps at 25). */
  surchargeCap: number;
}

// FY 2025-26 (AY 2026-27). New regime is the default.
export const NEW_REGIME: RegimeSpec = {
  slabs: [
    { upTo: 400000, rate: 0 },
    { upTo: 800000, rate: 5 },
    { upTo: 1200000, rate: 10 },
    { upTo: 1600000, rate: 15 },
    { upTo: 2000000, rate: 20 },
    { upTo: 2400000, rate: 25 },
    { upTo: Infinity, rate: 30 },
  ],
  standardDeduction: 75000,
  rebateLimit: 1200000,
  rebateCap: 60000,
  surchargeCap: 25,
};

export const OLD_REGIME: RegimeSpec = {
  slabs: [
    { upTo: 250000, rate: 0 },
    { upTo: 500000, rate: 5 },
    { upTo: 1000000, rate: 20 },
    { upTo: Infinity, rate: 30 },
  ],
  standardDeduction: 50000,
  rebateLimit: 500000,
  rebateCap: 12500,
  surchargeCap: 37,
};

export function regimeSpec(regime: TaxRegime): RegimeSpec {
  return regime === 'old' ? OLD_REGIME : NEW_REGIME;
}

const CESS_RATE = 0.04; // Health & Education cess on (tax + surcharge)

/** Progressive slab tax on a taxable income. */
export function slabTax(taxableIncome: number, slabs: Slab[]): number {
  let tax = 0;
  let prev = 0;
  const income = Math.max(0, taxableIncome);
  for (const s of slabs) {
    if (income <= prev) break;
    const band = Math.min(income, s.upTo) - prev;
    tax += band * (s.rate / 100);
    prev = s.upTo;
  }
  return tax;
}

/** Surcharge on the base tax by income band (regime-capped rate). */
function surcharge(baseTax: number, taxableIncome: number, spec: RegimeSpec): number {
  let rate = 0;
  if (taxableIncome > 20000000) rate = 37;
  else if (taxableIncome > 10000000) rate = 15;
  else if (taxableIncome > 5000000) rate = 10;
  rate = Math.min(rate, spec.surchargeCap);
  return baseTax * (rate / 100);
}

/** The line-by-line tax computation (for Form 16 Part B and any detailed view). */
export interface TaxBreakdown {
  /** Progressive slab tax before any rebate. */
  slabTax: number;
  /** §87A rebate applied (0 above the rebate limit). */
  rebate: number;
  /** Slab tax after the rebate (and new-regime marginal relief). */
  taxAfterRebate: number;
  surcharge: number;
  cess: number;
  /** Total tax = taxAfterRebate + surcharge + cess (rounded). */
  totalTax: number;
}

/**
 * Line-by-line annual income tax on a TAXABLE income (after all deductions):
 * slab tax → §87A rebate (with new-regime marginal relief at the rebate boundary)
 * → surcharge → 4% cess. The single source of truth for the tax numbers.
 */
export function computeTaxBreakdown(taxableIncome: number, regime: TaxRegime): TaxBreakdown {
  const spec = regimeSpec(regime);
  const income = Math.max(0, taxableIncome);
  const gross = slabTax(income, spec.slabs);
  let tax = gross;

  if (income <= spec.rebateLimit) {
    // Rebate wipes the tax out entirely up to the limit.
    tax = Math.max(0, tax - Math.min(tax, spec.rebateCap));
  } else if (regime === 'new') {
    // Marginal relief just above the rebate limit: the tax can't exceed the income
    // over the limit. (min() is safe across the range — beyond the crossover the
    // slab tax is already the smaller of the two.)
    tax = Math.min(tax, income - spec.rebateLimit);
  }

  const sur = surcharge(tax, income, spec);
  const cess = (tax + sur) * CESS_RATE;
  return {
    slabTax: round0(gross),
    rebate: round0(gross - tax),
    taxAfterRebate: round0(tax),
    surcharge: round0(sur),
    cess: round0(cess),
    totalTax: round0(tax + sur + cess),
  };
}

/**
 * Total annual income tax on a TAXABLE income (after all deductions), for a regime.
 * Thin wrapper over {@link computeTaxBreakdown}.
 */
export function computeAnnualTax(taxableIncome: number, regime: TaxRegime): number {
  return computeTaxBreakdown(taxableIncome, regime).totalTax;
}

/** Financial-year month index: Apr = 1 … Mar = 12 (India FY). */
export function fyMonthIndex(month: number): number {
  return month >= 4 ? month - 3 : month + 9;
}

export interface MonthlyTdsInput {
  /** Projected TAXABLE annual income for the FY (gross − std deduction − exemptions). */
  annualTaxable: number;
  regime: TaxRegime;
  /** Calendar month 1-12 (drives how many FY months remain to spread the tax over). */
  month: number;
  /** TDS already withheld earlier this FY (the true-up base). */
  tdsPaidYtd: number;
}

/**
 * Monthly TDS to withhold: the projected annual tax minus what's already been
 * withheld, spread evenly over the months of the FY that remain (this one included).
 * Never negative (no refund through payroll).
 */
export function computeMonthlyTds(input: MonthlyTdsInput): { annualTax: number; monthly: number } {
  const annualTax = computeAnnualTax(input.annualTaxable, input.regime);
  const remaining = Math.max(1, 13 - fyMonthIndex(input.month));
  const monthly = Math.max(0, round0((annualTax - Math.max(0, input.tdsPaidYtd)) / remaining));
  return { annualTax, monthly };
}
