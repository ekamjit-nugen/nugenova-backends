/**
 * Payroll statutory configuration — the org's PF / ESI / Professional-Tax rulebook,
 * owner-configurable and stored on a policy row (category `payroll`, applicableTo
 * `all`) in `extraConfig.payroll`. This is the SINGLE source of truth for the
 * statutory rates + ceilings + PT state the payroll engine applies; nothing is
 * hardcoded in the run path. Mirrors the leave-config pattern.
 *
 * The pure computation lives in `payroll/statutory.ts`; this file only owns the
 * default / resolve / sanitize of the owner-editable config, plus the PT-state
 * option list the Settings UI renders.
 */
import {
  DEFAULT_STATUTORY_CONFIG,
  PayrollStatutoryConfig,
  PfConfig,
  EsiConfig,
  PT_STATES,
} from '../payroll/statutory';

/** What a caller may submit — every field optional (fills from defaults). */
export interface PayrollConfigInput {
  pf?: Partial<PfConfig>;
  esi?: Partial<EsiConfig>;
  ptState?: string;
}

/** The default statutory config — the editor's starting point. */
export function defaultPayrollConfig(): PayrollStatutoryConfig {
  // Deep clone so callers can't mutate the shared default.
  return {
    pf: { ...DEFAULT_STATUTORY_CONFIG.pf },
    esi: { ...DEFAULT_STATUTORY_CONFIG.esi },
    ptState: DEFAULT_STATUTORY_CONFIG.ptState,
  };
}

/** The PT-state options for the Settings → Payroll dropdown. */
export function ptStateOptions(): { value: string; label: string }[] {
  return Object.entries(PT_STATES).map(([value, def]) => ({ value, label: def.label }));
}

const num = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof v === 'number' && isFinite(v) ? v : fallback;
  return Math.min(Math.max(n, min), max);
};

const bool = (v: unknown, fallback: boolean): boolean =>
  typeof v === 'boolean' ? v : fallback;

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
  const ptState = typeof s.ptState === 'string' && PT_STATES[s.ptState] ? s.ptState : d.ptState;
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
  };
}

/** Canonicalise a submitted config down to the persisted (already-clamped) shape. */
export function sanitizePayrollConfig(
  input: PayrollConfigInput | null | undefined,
): PayrollStatutoryConfig {
  return resolvePayrollConfig(input);
}
