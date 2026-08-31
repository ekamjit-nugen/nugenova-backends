/**
 * Statutory deduction engine (Phase 2) — pure, deterministic, unit-tested. Ported
 * from the legacy Nugenova payroll-calculation service (PF/ESI/PT rules). Amounts
 * in RUPEES. TDS (income tax) is a later increment.
 *
 * PF  — Provident Fund on the PF wage (basic, capped at the wage ceiling), split
 *       into an employee share (deducted) and an employer share (contribution).
 * ESI — Employees' State Insurance, only when monthly gross ≤ the ESI ceiling.
 * PT  — Professional Tax, a state-slab lookup on monthly gross.
 */

const round0 = (n: number) => Math.round(n);

// ── config shapes ─────────────────────────────────────────────────────────────

export interface PfConfig {
  enabled: boolean;
  employeeRate: number; // percent, e.g. 12
  employerRate: number; // percent, e.g. 12
  wageCeiling: number; // rupees/month, e.g. 15000
}
export interface EsiConfig {
  enabled: boolean;
  employeeRate: number; // percent, e.g. 0.75
  employerRate: number; // percent, e.g. 3.25
  wageCeiling: number; // rupees/month, e.g. 21000
}
export interface PayrollStatutoryConfig {
  pf: PfConfig;
  esi: EsiConfig;
  /** State code driving the PT slab; 'none' disables PT. */
  ptState: string;
  /** Labour Welfare Fund (state, periodic). */
  lwf: LwfConfig;
  /** Owner-defined org-wide deductions / contributions. */
  customDeductions: CustomStatutoryItem[];
}

export const DEFAULT_STATUTORY_CONFIG: PayrollStatutoryConfig = {
  pf: { enabled: true, employeeRate: 12, employerRate: 12, wageCeiling: 15000 },
  esi: { enabled: true, employeeRate: 0.75, employerRate: 3.25, wageCeiling: 21000 },
  ptState: 'MH',
  lwf: { enabled: false, state: 'none' },
  customDeductions: [],
};

// ── PF ─────────────────────────────────────────────────────────────────────────

export function computePF(basicMonthly: number, cfg: PfConfig): { employee: number; employer: number; wage: number } {
  if (!cfg.enabled) return { employee: 0, employer: 0, wage: 0 };
  const wage = Math.min(Math.max(0, basicMonthly), Math.max(0, cfg.wageCeiling));
  return {
    wage: round0(wage),
    employee: round0(wage * (cfg.employeeRate / 100)),
    employer: round0(wage * (cfg.employerRate / 100)),
  };
}

// ── ESI ──────────────────────────────────────────────────────────────────────

export function computeESI(grossMonthly: number, cfg: EsiConfig): { employee: number; employer: number } {
  if (!cfg.enabled || grossMonthly > cfg.wageCeiling) return { employee: 0, employer: 0 };
  return {
    employee: round0(grossMonthly * (cfg.employeeRate / 100)),
    employer: round0(grossMonthly * (cfg.employerRate / 100)),
  };
}

// ── Professional Tax (state slabs) ────────────────────────────────────────────

/** A PT slab: monthly gross in [upTo(prev), upTo] pays `amount` (₹/month). */
interface PtSlab {
  upTo: number; // inclusive upper bound of monthly gross; Infinity for the top slab
  amount: number;
}

/**
 * Monthly PT slabs for the states we support. `none` (and states with no PT —
 * Delhi, Haryana, UP, etc.) resolve to zero. Simplified/representative slabs
 * (the legacy 24-state table can be ported in full later). Maharashtra's Feb bump
 * is handled by the caller via `month`.
 */
export const PT_STATES: Record<string, { label: string; slabs: PtSlab[]; febBump?: number }> = {
  none: { label: 'No Professional Tax', slabs: [{ upTo: Infinity, amount: 0 }] },
  MH: {
    label: 'Maharashtra',
    slabs: [
      { upTo: 7500, amount: 0 },
      { upTo: 10000, amount: 175 },
      { upTo: Infinity, amount: 200 },
    ],
    febBump: 300, // February pays ₹300 in the top slab
  },
  KA: {
    label: 'Karnataka',
    slabs: [
      { upTo: 24999, amount: 0 },
      { upTo: Infinity, amount: 200 },
    ],
  },
  WB: {
    label: 'West Bengal',
    slabs: [
      { upTo: 10000, amount: 0 },
      { upTo: 15000, amount: 110 },
      { upTo: 25000, amount: 130 },
      { upTo: 40000, amount: 150 },
      { upTo: Infinity, amount: 200 },
    ],
  },
  TN: {
    label: 'Tamil Nadu',
    slabs: [
      { upTo: 21000, amount: 0 },
      { upTo: 30000, amount: 135 },
      { upTo: 45000, amount: 315 },
      { upTo: 60000, amount: 690 },
      { upTo: 75000, amount: 1025 },
      { upTo: Infinity, amount: 1250 },
    ],
  },
  TS: {
    label: 'Telangana',
    slabs: [
      { upTo: 15000, amount: 0 },
      { upTo: 20000, amount: 150 },
      { upTo: Infinity, amount: 200 },
    ],
  },
  GJ: {
    label: 'Gujarat',
    slabs: [
      { upTo: 12000, amount: 0 },
      { upTo: Infinity, amount: 200 },
    ],
  },
  MP: {
    label: 'Madhya Pradesh',
    slabs: [
      { upTo: 18750, amount: 0 },
      { upTo: 25000, amount: 125 },
      { upTo: 33333, amount: 167 },
      { upTo: Infinity, amount: 208 },
    ],
  },
};

export function ptStateLabel(state: string): string {
  return PT_STATES[state]?.label ?? state;
}

/** Professional tax for a monthly gross in a state. `month` (1-12) applies MH's Feb bump. */
export function computePT(grossMonthly: number, state: string, month: number): number {
  const def = PT_STATES[state] ?? PT_STATES.none;
  const slab = def.slabs.find((s) => grossMonthly <= s.upTo) ?? def.slabs[def.slabs.length - 1];
  // Maharashtra: the top slab pays the Feb bump in February.
  if (def.febBump && month === 2 && slab.amount === def.slabs[def.slabs.length - 1].amount) {
    return def.febBump;
  }
  return slab.amount;
}

// ── Labour Welfare Fund (state, periodic) ─────────────────────────────────────

export interface LwfConfig {
  enabled: boolean;
  /** State code driving the LWF amounts; 'none' disables. */
  state: string;
}

/**
 * LWF is a small, state-set contribution usually collected in specific months
 * (most states: half-yearly in June & December). Representative monthly amounts +
 * the months they apply; `none` and unlisted states resolve to zero. (The exact
 * per-state figures/frequencies can be tuned in config or via a custom item.)
 */
export const LWF_STATES: Record<
  string,
  { label: string; employee: number; employer: number; months: number[] }
> = {
  none: { label: 'No Labour Welfare Fund', employee: 0, employer: 0, months: [] },
  MH: { label: 'Maharashtra', employee: 25, employer: 75, months: [6, 12] },
  KA: { label: 'Karnataka', employee: 20, employer: 40, months: [12] },
  TN: { label: 'Tamil Nadu', employee: 20, employer: 40, months: [12] },
  GJ: { label: 'Gujarat', employee: 6, employer: 12, months: [6, 12] },
  WB: { label: 'West Bengal', employee: 3, employer: 15, months: [6, 12] },
  MP: { label: 'Madhya Pradesh', employee: 10, employer: 30, months: [6, 12] },
  AP: { label: 'Andhra Pradesh', employee: 30, employer: 70, months: [12] },
  TS: { label: 'Telangana', employee: 2, employer: 5, months: [12] },
  HR: { label: 'Haryana', employee: 31, employer: 62, months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
  PB: { label: 'Punjab', employee: 5, employer: 20, months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
  DL: { label: 'Delhi', employee: 3, employer: 6, months: [6, 12] },
};

export function lwfStateLabel(state: string): string {
  return LWF_STATES[state]?.label ?? state;
}

/** LWF employee/employer amounts for a month (0 outside the applicable months). */
export function computeLWF(cfg: LwfConfig, month: number): { employee: number; employer: number } {
  if (!cfg.enabled) return { employee: 0, employer: 0 };
  const def = LWF_STATES[cfg.state];
  if (!def || !def.months.includes(month)) return { employee: 0, employer: 0 };
  return { employee: round0(def.employee), employer: round0(def.employer) };
}

// ── custom deductions / contributions (owner-defined, org-wide) ────────────────

export type DeductionBasis =
  | 'fixed' // employeeValue / employerValue are rupee amounts
  | 'percent_gross' // % of full monthly gross (pre-LOP)
  | 'percent_earned_gross' // % of LOP-adjusted gross
  | 'percent_basic'; // % of (LOP-adjusted) Basic

export const DEDUCTION_BASES: { value: DeductionBasis; label: string }[] = [
  { value: 'fixed', label: 'Fixed amount (₹)' },
  { value: 'percent_gross', label: '% of gross' },
  { value: 'percent_earned_gross', label: '% of earned gross (after LOP)' },
  { value: 'percent_basic', label: '% of Basic' },
];

/**
 * An owner-defined line that applies to everyone: a deduction (employeeValue > 0),
 * an employer contribution (employerValue > 0), or both. Covers VPF, NPS, group
 * insurance, gratuity provision, a flat/percent TDS, etc.
 */
export interface CustomStatutoryItem {
  code: string;
  name: string;
  enabled: boolean;
  basis: DeductionBasis;
  employeeValue: number;
  employerValue: number;
}

export interface CustomLine {
  code: string;
  name: string;
  employee: number;
  employer: number;
}

const applyBasis = (
  basis: DeductionBasis,
  value: number,
  ctx: { gross: number; earnedGross: number; basic: number },
): number => {
  if (value <= 0) return 0;
  switch (basis) {
    case 'fixed':
      return round0(value);
    case 'percent_gross':
      return round0(ctx.gross * (value / 100));
    case 'percent_earned_gross':
      return round0(ctx.earnedGross * (value / 100));
    case 'percent_basic':
      return round0(ctx.basic * (value / 100));
    default:
      return 0;
  }
};

/** Evaluate one custom item into concrete employee/employer rupee amounts. */
export function evalCustomItem(
  item: CustomStatutoryItem,
  ctx: { gross: number; earnedGross: number; basic: number },
): CustomLine {
  if (!item.enabled) return { code: item.code, name: item.name, employee: 0, employer: 0 };
  return {
    code: item.code,
    name: item.name,
    employee: applyBasis(item.basis, item.employeeValue, ctx),
    employer: applyBasis(item.basis, item.employerValue, ctx),
  };
}

// ── aggregate ─────────────────────────────────────────────────────────────────

export interface StatutoryResult {
  pfEmployee: number;
  pfEmployer: number;
  pfWage: number;
  esiEmployee: number;
  esiEmployer: number;
  professionalTax: number;
  lwfEmployee: number;
  lwfEmployer: number;
  /** Owner-defined org-wide lines (resolved to amounts). */
  custom: CustomLine[];
  /** Total deducted from the employee's pay (statutory + custom employee side). */
  employeeDeductions: number;
  /** Total employer-side contributions (NOT deducted from net). */
  employerContributions: number;
}

/**
 * Compute all statutory + custom figures for a month. `basic` drives PF/`percent_basic`;
 * `gross` (the LOP-adjusted monthly gross) drives ESI/PT/LWF/`percent_*`. `fullGross`
 * is the pre-LOP gross used only by the `percent_gross` basis.
 */
export function computeStatutory(
  basic: number,
  gross: number,
  month: number,
  cfg: PayrollStatutoryConfig,
  fullGross: number = gross,
): StatutoryResult {
  const pf = computePF(basic, cfg.pf);
  const esi = computeESI(gross, cfg.esi);
  const pt = computePT(gross, cfg.ptState, month);
  const lwf = computeLWF(cfg.lwf ?? { enabled: false, state: 'none' }, month);

  const ctx = { gross: fullGross, earnedGross: gross, basic };
  const custom = (cfg.customDeductions ?? [])
    .map((it) => evalCustomItem(it, ctx))
    .filter((l) => l.employee > 0 || l.employer > 0);

  const customEmployee = custom.reduce((t, l) => t + l.employee, 0);
  const customEmployer = custom.reduce((t, l) => t + l.employer, 0);

  return {
    pfEmployee: pf.employee,
    pfEmployer: pf.employer,
    pfWage: pf.wage,
    esiEmployee: esi.employee,
    esiEmployer: esi.employer,
    professionalTax: pt,
    lwfEmployee: lwf.employee,
    lwfEmployer: lwf.employer,
    custom,
    employeeDeductions: pf.employee + esi.employee + pt + lwf.employee + customEmployee,
    employerContributions: pf.employer + esi.employer + lwf.employer + customEmployer,
  };
}
