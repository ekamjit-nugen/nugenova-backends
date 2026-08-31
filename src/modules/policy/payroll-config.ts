/**
 * Payroll statutory configuration — the org's PF / ESI / PT / LWF rulebook plus
 * any owner-defined custom deductions, stored on a policy row (category `payroll`,
 * applicableTo `all`) in `extraConfig.payroll`. This is the SINGLE source of truth
 * for what the payroll engine deducts; nothing is hardcoded in the run path.
 * Mirrors the leave-config pattern.
 *
 * The pure computation lives in `payroll/statutory.ts`; this file only owns the
 * default / resolve / sanitize of the owner-editable config, plus the option lists
 * (PT/LWF states, deduction bases) the Settings UI renders.
 */
import {
  DEFAULT_STATUTORY_CONFIG,
  PayrollStatutoryConfig,
  PfConfig,
  EsiConfig,
  LwfConfig,
  CustomStatutoryItem,
  DeductionBasis,
  DEDUCTION_BASES,
  PT_STATES,
  LWF_STATES,
  INDIAN_STATES,
  isIndianState,
} from '../payroll/statutory';
import { DEDUCTION_TEMPLATES, DeductionTemplate } from '../payroll/deduction-templates';

/** A submitted custom line — `basis` is a loose string until sanitized/validated. */
export interface CustomDeductionInput {
  code?: string;
  name?: string;
  enabled?: boolean;
  basis?: string;
  employeeValue?: number;
  employerValue?: number;
}

/** What a caller may submit — every field optional (fills from defaults). */
export interface PayrollConfigInput {
  pf?: Partial<PfConfig>;
  esi?: Partial<EsiConfig>;
  ptState?: string;
  lwf?: Partial<LwfConfig>;
  customDeductions?: CustomDeductionInput[];
}

/**
 * A fresh org's config — OPT-IN: every deduction starts off. The canonical rates
 * are still filled in (from `DEFAULT_STATUTORY_CONFIG`) so that when the owner adds
 * a statutory deduction it already carries the standard rate/ceiling; only the
 * `enabled` flags (and PT/LWF state) start "off". Owners add what they need from
 * the template library.
 */
export function defaultPayrollConfig(): PayrollStatutoryConfig {
  return {
    pf: { ...DEFAULT_STATUTORY_CONFIG.pf, enabled: false },
    esi: { ...DEFAULT_STATUTORY_CONFIG.esi, enabled: false },
    ptState: 'none',
    lwf: { enabled: false, state: 'none' },
    customDeductions: [],
  };
}

const ALL_STATE_OPTIONS = INDIAN_STATES.map((s) => ({ value: s.code, label: s.name }));

/** PT-state options: "no PT" + every Indian state / UT. */
export function ptStateOptions(): { value: string; label: string }[] {
  return [{ value: 'none', label: PT_STATES.none.label }, ...ALL_STATE_OPTIONS];
}

/** LWF-state options: "no LWF" + every Indian state / UT. */
export function lwfStateOptions(): { value: string; label: string }[] {
  return [{ value: 'none', label: LWF_STATES.none.label }, ...ALL_STATE_OPTIONS];
}

/** The custom-deduction basis options for the editor. */
export function deductionBasisOptions(): { value: DeductionBasis; label: string }[] {
  return DEDUCTION_BASES;
}

/** The deduction template library (opt-in catalog with full info). */
export function deductionTemplates(): DeductionTemplate[] {
  return DEDUCTION_TEMPLATES;
}

const num = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof v === 'number' && isFinite(v) ? v : fallback;
  return Math.min(Math.max(n, min), max);
};

const bool = (v: unknown, fallback: boolean): boolean =>
  typeof v === 'boolean' ? v : fallback;

const VALID_BASES = new Set(DEDUCTION_BASES.map((b) => b.value));
const CODE_RE = /^[A-Z0-9_]{1,20}$/;
const MAX_CUSTOM_DEDUCTIONS = 25;

/** Canonicalise the owner-defined custom deduction/contribution lines. */
function sanitizeCustomDeductions(
  input: CustomDeductionInput[] | null | undefined,
): CustomStatutoryItem[] {
  const seen = new Set<string>();
  const out: CustomStatutoryItem[] = [];
  for (const it of input || []) {
    if (out.length >= MAX_CUSTOM_DEDUCTIONS) break;
    const code = String(it?.code || '').trim().toUpperCase();
    const name = String(it?.name || '').trim();
    if (!CODE_RE.test(code) || seen.has(code) || !name) continue;
    const basis: DeductionBasis = VALID_BASES.has(it?.basis as DeductionBasis)
      ? (it!.basis as DeductionBasis)
      : 'fixed';
    // Percent bases clamp to 0–100; fixed amounts clamp to 0–10,000,000.
    const cap = basis === 'fixed' ? 10_000_000 : 100;
    const employeeValue = num(it?.employeeValue, 0, 0, cap);
    const employerValue = num(it?.employerValue, 0, 0, cap);
    if (employeeValue <= 0 && employerValue <= 0) continue;
    seen.add(code);
    out.push({
      code,
      name: name.slice(0, 60),
      enabled: bool(it?.enabled, true),
      basis,
      employeeValue: basis === 'fixed' ? Math.round(employeeValue) : employeeValue,
      employerValue: basis === 'fixed' ? Math.round(employerValue) : employerValue,
    });
  }
  return out;
}

/**
 * Resolve a stored (possibly partial) config into a full one: any missing/invalid
 * field falls back to the default, and every numeric field is clamped to a sane
 * range so a bad save can't produce absurd deductions.
 */
export function resolvePayrollConfig(
  stored: PayrollConfigInput | null | undefined,
): PayrollStatutoryConfig {
  const d = defaultPayrollConfig();
  const s = stored || {};
  const pf: Partial<PfConfig> = s.pf || {};
  const esi: Partial<EsiConfig> = s.esi || {};
  const lwf: Partial<LwfConfig> = s.lwf || {};
  const validState = (v: unknown): v is string =>
    typeof v === 'string' && (v === 'none' || isIndianState(v));
  const ptState = validState(s.ptState) ? s.ptState : d.ptState;
  const lwfState = validState(lwf.state) ? lwf.state : d.lwf.state;
  return {
    pf: {
      enabled: bool(pf.enabled, d.pf.enabled),
      employeeRate: num(pf.employeeRate, d.pf.employeeRate, 0, 100),
      employerRate: num(pf.employerRate, d.pf.employerRate, 0, 100),
      wageCeiling: Math.round(num(pf.wageCeiling, d.pf.wageCeiling, 0, 10_000_000)),
    },
    esi: {
      enabled: bool(esi.enabled, d.esi.enabled),
      employeeRate: num(esi.employeeRate, d.esi.employeeRate, 0, 100),
      employerRate: num(esi.employerRate, d.esi.employerRate, 0, 100),
      wageCeiling: Math.round(num(esi.wageCeiling, d.esi.wageCeiling, 0, 10_000_000)),
    },
    ptState,
    lwf: { enabled: bool(lwf.enabled, d.lwf.enabled), state: lwfState },
    customDeductions: sanitizeCustomDeductions(s.customDeductions),
  };
}

/** Canonicalise a submitted config down to the persisted (already-clamped) shape. */
export function sanitizePayrollConfig(
  input: PayrollConfigInput | null | undefined,
): PayrollStatutoryConfig {
  return resolvePayrollConfig(input);
}
