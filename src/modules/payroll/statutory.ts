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
}

export const DEFAULT_STATUTORY_CONFIG: PayrollStatutoryConfig = {
  pf: { enabled: true, employeeRate: 12, employerRate: 12, wageCeiling: 15000 },
  esi: { enabled: true, employeeRate: 0.75, employerRate: 3.25, wageCeiling: 21000 },
  ptState: 'MH',
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

// ── aggregate ─────────────────────────────────────────────────────────────────

export interface StatutoryResult {
  pfEmployee: number;
  pfEmployer: number;
  pfWage: number;
  esiEmployee: number;
  esiEmployer: number;
  professionalTax: number;
  /** Total deducted from the employee's pay. */
  employeeDeductions: number;
  /** Total employer-side contributions (NOT deducted from net). */
  employerContributions: number;
}

/**
 * Compute all statutory figures for a month. `basic` drives PF; `gross` (the
 * proration-adjusted monthly gross) drives ESI + PT.
 */
export function computeStatutory(
  basic: number,
  gross: number,
  month: number,
  cfg: PayrollStatutoryConfig,
): StatutoryResult {
  const pf = computePF(basic, cfg.pf);
  const esi = computeESI(gross, cfg.esi);
  const pt = computePT(gross, cfg.ptState, month);
  return {
    pfEmployee: pf.employee,
    pfEmployer: pf.employer,
    pfWage: pf.wage,
    esiEmployee: esi.employee,
    esiEmployer: esi.employer,
    professionalTax: pt,
    employeeDeductions: pf.employee + esi.employee + pt,
    employerContributions: pf.employer + esi.employer,
  };
}
