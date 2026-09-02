import { TaxRegime, regimeSpec, computeTaxBreakdown, TaxBreakdown } from './tds';

/**
 * Form 16 Part B — the employer's annual salary + tax computation for one
 * employee in a financial year. Pure: the numbers come straight from the FY's
 * payslips and the (verified) declaration; identity fields are filled by the
 * caller. Part A (challan/deposit details) comes from TRACES, not from here — we
 * surface the tax we actually *deducted* (from the payslips) as the deducted total.
 *
 * FY 2025-26 rules via {@link regimeSpec}. Under the NEW regime the §10 exemptions,
 * house-property interest and Chapter VI-A deductions don't apply, so they're
 * zeroed regardless of what was declared.
 */
export interface Form16Inputs {
  fyStart: number;
  regime: TaxRegime;
  /** Sum of the FY's gross earnings (rupees). */
  grossSalary: number;
  /** §10 exemptions — HRA etc. (old regime only). */
  section10Exemptions: number;
  /** §24(b) home-loan interest — a loss from house property, capped ₹2L (old regime only). */
  homeLoanInterest: number;
  chapterVIA: { section80C: number; section80D: number; section80E: number; other: number };
  /** TDS actually withheld across the FY (from payslips). */
  tdsDeducted: number;
  quarterlyTds: { q1: number; q2: number; q3: number; q4: number };
}

export interface Form16PartB {
  financialYear: string;
  assessmentYear: string;
  regime: TaxRegime;
  grossSalary: number;
  section10Exemptions: number;
  standardDeduction: number;
  netSalary: number;
  homeLoanInterest: number;
  grossTotalIncome: number;
  chapterVIA: { section80C: number; section80D: number; section80E: number; other: number; total: number };
  taxableIncome: number;
  tax: TaxBreakdown;
  taxPayable: number;
  tdsDeducted: number;
  quarterlyTds: { q1: number; q2: number; q3: number; q4: number };
  /** taxPayable − tdsDeducted: positive = shortfall, negative = excess withheld (informational). */
  balance: number;
}

const CAP_80C = 150000;
const CAP_24B = 200000;
const r0 = (n: number) => Math.round(n || 0);

export function fyLabel(fyStart: number): string {
  return `${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`;
}

export function buildForm16PartB(input: Form16Inputs): Form16PartB {
  const old = input.regime === 'old';
  const spec = regimeSpec(input.regime);

  const grossSalary = Math.max(0, r0(input.grossSalary));
  const section10 = old ? Math.max(0, r0(input.section10Exemptions)) : 0;
  const standardDeduction = spec.standardDeduction;
  const netSalary = Math.max(0, grossSalary - section10 - standardDeduction);

  const homeLoanInterest = old ? Math.min(Math.max(0, r0(input.homeLoanInterest)), CAP_24B) : 0;
  const grossTotalIncome = Math.max(0, netSalary - homeLoanInterest);

  const c = input.chapterVIA;
  const chapterVIA = old
    ? {
        section80C: Math.min(Math.max(0, r0(c.section80C)), CAP_80C),
        section80D: Math.max(0, r0(c.section80D)),
        section80E: Math.max(0, r0(c.section80E)),
        other: Math.max(0, r0(c.other)),
        total: 0,
      }
    : { section80C: 0, section80D: 0, section80E: 0, other: 0, total: 0 };
  chapterVIA.total = chapterVIA.section80C + chapterVIA.section80D + chapterVIA.section80E + chapterVIA.other;

  const taxableIncome = Math.max(0, grossTotalIncome - chapterVIA.total);
  const tax = computeTaxBreakdown(taxableIncome, input.regime);
  const tdsDeducted = Math.max(0, r0(input.tdsDeducted));

  return {
    financialYear: fyLabel(input.fyStart),
    assessmentYear: fyLabel(input.fyStart + 1),
    regime: input.regime,
    grossSalary,
    section10Exemptions: section10,
    standardDeduction,
    netSalary,
    homeLoanInterest,
    grossTotalIncome,
    chapterVIA,
    taxableIncome,
    tax,
    taxPayable: tax.totalTax,
    tdsDeducted,
    quarterlyTds: {
      q1: Math.max(0, r0(input.quarterlyTds.q1)),
      q2: Math.max(0, r0(input.quarterlyTds.q2)),
      q3: Math.max(0, r0(input.quarterlyTds.q3)),
      q4: Math.max(0, r0(input.quarterlyTds.q4)),
    },
    balance: tax.totalTax - tdsDeducted,
  };
}

/** Which FY quarter a calendar month falls in: Q1 Apr-Jun, Q2 Jul-Sep, Q3 Oct-Dec, Q4 Jan-Mar. */
export function fyQuarter(month: number): 'q1' | 'q2' | 'q3' | 'q4' {
  if (month >= 4 && month <= 6) return 'q1';
  if (month >= 7 && month <= 9) return 'q2';
  if (month >= 10 && month <= 12) return 'q3';
  return 'q4';
}
