/**
 * Deduction template library — the catalog of every deduction an org can opt into,
 * each with complete information (what it does, how much, who bears it). The
 * Settings → Payroll UI renders this as a "add from library" list; nothing is
 * enabled for an org until the owner adds it.
 *
 * Two kinds:
 *  - `statutory` — the four built-in computed deductions (PF/ESI/PT/LWF). Adding one
 *    flips its flag in the statutory config; its rates/ceilings are edited inline.
 *  - `custom` — a generic owner-defined line the engine evaluates by `basis`. Adding
 *    one seeds a `customDeductions` row from the template's defaults, then it's
 *    freely editable. Covers VPF, NPS, gratuity, insurances, TDS, meal cards, etc.
 *
 * This is descriptive metadata only — the actual computation lives in `statutory.ts`.
 */
import { DeductionBasis } from './statutory';

export type DeductionKind = 'statutory' | 'custom';
export type DeductionWhoPays = 'employee' | 'employer' | 'both';

export interface DeductionTemplate {
  /** For statutory: 'pf'|'esi'|'pt'|'lwf'. For custom: a stable slug used as the code. */
  key: string;
  kind: DeductionKind;
  name: string;
  /** What it is / what it does — one or two sentences. */
  description: string;
  /** How much — a plain-language rate/amount summary. */
  summary: string;
  whoPays: DeductionWhoPays;
  /** Legally required for eligible employers (shown as a badge). */
  mandatory: boolean;
  /** For `custom` templates — the prefill applied when the owner adds it. */
  defaultBasis?: DeductionBasis;
  defaultEmployeeValue?: number;
  defaultEmployerValue?: number;
  /** Optional caveat shown under the template. */
  note?: string;
}

export const DEDUCTION_TEMPLATES: DeductionTemplate[] = [
  // ── statutory (built-in computed) ────────────────────────────────────────────
  {
    key: 'pf',
    kind: 'statutory',
    name: "Provident Fund (EPF)",
    description:
      "Retirement savings under the EPF Act. Deducted from the employee's Basic pay and matched by the employer.",
    summary: '12% of Basic (wage capped at ₹15,000/mo); employer matches 12%.',
    whoPays: 'both',
    mandatory: true,
  },
  {
    key: 'esi',
    kind: 'statutory',
    name: "Employees' State Insurance (ESI)",
    description:
      'Medical + cash benefits under the ESI Act for lower-wage employees. Applies only when monthly gross is within the wage ceiling.',
    summary: '0.75% of gross (employee) + 3.25% (employer), only when gross ≤ ₹21,000/mo.',
    whoPays: 'both',
    mandatory: true,
  },
  {
    key: 'pt',
    kind: 'statutory',
    name: 'Professional Tax (PT)',
    description:
      'A state-levied tax on employment, deducted from gross pay and deposited with the state. Rates and slabs are set per state.',
    summary: 'A state-slab amount on monthly gross (e.g. up to ₹200/mo in Maharashtra).',
    whoPays: 'employee',
    mandatory: true,
    note: 'Only some states levy PT — pick your state of registration when you add it.',
  },
  {
    key: 'lwf',
    kind: 'statutory',
    name: 'Labour Welfare Fund (LWF)',
    description:
      'A small state welfare-fund contribution from both employee and employer, collected in specific months.',
    summary: 'A small state-set amount (≈₹25–75), usually in June & December.',
    whoPays: 'both',
    mandatory: true,
    note: 'Applicability and amounts vary by state; not all states have an LWF.',
  },

  // ── custom (generic owner-defined) ───────────────────────────────────────────
  {
    key: 'VPF',
    kind: 'custom',
    name: 'Voluntary Provident Fund (VPF)',
    description:
      'Extra provident-fund savings an employee chooses on top of the mandatory 12% EPF. Fully employee-funded.',
    summary: 'An employee-set % of Basic, over and above EPF.',
    whoPays: 'employee',
    mandatory: false,
    defaultBasis: 'percent_basic',
    defaultEmployeeValue: 10,
    defaultEmployerValue: 0,
  },
  {
    key: 'NPS',
    kind: 'custom',
    name: 'National Pension System (NPS)',
    description:
      'A government retirement scheme. Commonly an employer contribution of up to 10% of Basic, sometimes matched by the employee.',
    summary: 'Typically 10% of Basic (employer), optionally matched by the employee.',
    whoPays: 'both',
    mandatory: false,
    defaultBasis: 'percent_basic',
    defaultEmployeeValue: 0,
    defaultEmployerValue: 10,
  },
  {
    key: 'GRATUITY',
    kind: 'custom',
    name: 'Gratuity provision',
    description:
      "An employer provision toward end-of-service gratuity (payable after 5 years' service). Shown as an employer contribution, not a salary deduction.",
    summary: '≈4.81% of Basic, employer-funded.',
    whoPays: 'employer',
    mandatory: false,
    defaultBasis: 'percent_basic',
    defaultEmployeeValue: 0,
    defaultEmployerValue: 4.81,
  },
  {
    key: 'GHI',
    kind: 'custom',
    name: 'Group Health Insurance',
    description:
      'Employer-paid medical-cover premium for the employee (and often family). A fixed monthly amount per employee.',
    summary: 'A fixed monthly premium, usually employer-paid.',
    whoPays: 'employer',
    mandatory: false,
    defaultBasis: 'fixed',
    defaultEmployeeValue: 0,
    defaultEmployerValue: 500,
  },
  {
    key: 'GTLI',
    kind: 'custom',
    name: 'Group Term Life Insurance',
    description: 'Employer-paid life-cover premium for the employee. A fixed monthly amount.',
    summary: 'A fixed monthly premium, employer-paid.',
    whoPays: 'employer',
    mandatory: false,
    defaultBasis: 'fixed',
    defaultEmployeeValue: 0,
    defaultEmployerValue: 150,
  },
  {
    key: 'GPAI',
    kind: 'custom',
    name: 'Group Personal Accident',
    description: 'Employer-paid personal-accident cover premium. A fixed monthly amount.',
    summary: 'A fixed monthly premium, employer-paid.',
    whoPays: 'employer',
    mandatory: false,
    defaultBasis: 'fixed',
    defaultEmployeeValue: 0,
    defaultEmployerValue: 100,
  },
  {
    key: 'TDS',
    kind: 'custom',
    name: 'TDS (Income Tax)',
    description:
      'Tax Deducted at Source on salary income, deposited against the employee’s PAN. Set the monthly amount (or a flat percentage) here.',
    summary: 'A fixed monthly amount or a % of gross, per your tax computation.',
    whoPays: 'employee',
    mandatory: false,
    defaultBasis: 'fixed',
    defaultEmployeeValue: 0,
    defaultEmployerValue: 0,
    note: 'Enter the computed monthly TDS. A full slab-based projection engine is coming later.',
  },
  {
    key: 'MEAL',
    kind: 'custom',
    name: 'Meal Card / Food Coupons',
    description:
      'A fixed amount moved from salary onto a tax-exempt meal card each month, at the employee’s option.',
    summary: 'A fixed monthly amount deducted from salary.',
    whoPays: 'employee',
    mandatory: false,
    defaultBasis: 'fixed',
    defaultEmployeeValue: 0,
    defaultEmployerValue: 0,
  },
];
