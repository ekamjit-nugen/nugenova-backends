/**
 * Leave-type configuration — the org's leave rulebook, owner-configurable and
 * stored on a policy row (category `leave`, applicableTo `all`) in
 * `extraConfig.leave`. This is the SINGLE source of truth for which leave types
 * an org offers and their annual allocations. The leave module resolves
 * everything (types, allocations, system flags) from here via
 * `PolicyService.getLeaveConfig` — nothing is hardcoded in the leave engine.
 *
 * The owner controls `enabled` + `annualAllocation` per type; the system flags
 * (`balanceTracked`, `isLop`) and labels are intrinsic and come from the
 * defaults below. Ported from the legacy Nugenova `leaveConfig.leaveTypes`.
 */

export type LeaveTypeKey =
  | 'casual'
  | 'sick'
  | 'earned'
  | 'wfh'
  | 'maternity'
  | 'paternity'
  | 'bereavement'
  | 'comp_off'
  | 'lop';

/** Intrinsic definition of a leave type (labels + system flags + default alloc). */
export interface LeaveTypeDefault {
  key: LeaveTypeKey;
  label: string;
  defaultAllocation: number;
  /** false ⇒ no balance row / no deduction / no insufficient-balance block (lop). */
  balanceTracked: boolean;
  /** Loss-of-pay — bypasses all balance logic. */
  isLop: boolean;
}

export const LEAVE_TYPE_DEFAULTS: LeaveTypeDefault[] = [
  { key: 'casual', label: 'Casual Leave', defaultAllocation: 12, balanceTracked: true, isLop: false },
  { key: 'sick', label: 'Sick Leave', defaultAllocation: 12, balanceTracked: true, isLop: false },
  { key: 'earned', label: 'Earned Leave', defaultAllocation: 15, balanceTracked: true, isLop: false },
  { key: 'wfh', label: 'Work From Home', defaultAllocation: 24, balanceTracked: true, isLop: false },
  { key: 'maternity', label: 'Maternity Leave', defaultAllocation: 180, balanceTracked: true, isLop: false },
  { key: 'paternity', label: 'Paternity Leave', defaultAllocation: 15, balanceTracked: true, isLop: false },
  { key: 'bereavement', label: 'Bereavement Leave', defaultAllocation: 5, balanceTracked: true, isLop: false },
  { key: 'comp_off', label: 'Comp Off', defaultAllocation: 0, balanceTracked: true, isLop: false },
  { key: 'lop', label: 'Loss of Pay', defaultAllocation: 0, balanceTracked: false, isLop: true },
];

export const LEAVE_TYPE_KEYS: LeaveTypeKey[] = LEAVE_TYPE_DEFAULTS.map((t) => t.key);

const DEFAULT_BY_KEY = new Map(LEAVE_TYPE_DEFAULTS.map((t) => [t.key, t]));

export function isValidLeaveType(key: string): key is LeaveTypeKey {
  return DEFAULT_BY_KEY.has(key as LeaveTypeKey);
}

/** A fully-resolved leave type as the leave engine + UI consume it. */
export interface ResolvedLeaveType {
  key: string;
  label: string;
  annualAllocation: number;
  balanceTracked: boolean;
  isLop: boolean;
  enabled: boolean;
  /** Owner-added type (not one of the 9 standard ones) — removable + label-editable. */
  custom: boolean;
}

export interface LeaveConfig {
  leaveTypes: ResolvedLeaveType[];
}

/** What's persisted per type — customs also carry their `label`. */
export interface StoredLeaveType {
  key: string;
  label?: string;
  annualAllocation: number;
  enabled: boolean;
}

/** Max owner-defined custom leave types. */
const MAX_CUSTOM_LEAVE_TYPES = 15;
const CUSTOM_KEY_RE = /^[a-z0-9_]{1,40}$/;

/** The default config: every catalog type enabled at its default allocation. */
export function defaultLeaveConfig(): LeaveConfig {
  return {
    leaveTypes: LEAVE_TYPE_DEFAULTS.map((t) => ({
      key: t.key,
      label: t.label,
      annualAllocation: t.defaultAllocation,
      balanceTracked: t.balanceTracked,
      isLop: t.isLop,
      enabled: true,
      custom: false,
    })),
  };
}

/**
 * Resolve a stored (minimal) config into the full type list: the 9 standard types
 * in catalog order (owner `enabled`/`annualAllocation` applied where saved; system
 * flags + labels from the catalog), then any owner-added CUSTOM types (their label
 * from storage; always balance-tracked, never lop).
 */
export function resolveLeaveConfig(stored: StoredLeaveType[] | null | undefined): LeaveConfig {
  const saved = stored || [];
  const savedByKey = new Map(saved.map((s) => [s.key, s]));

  const standards: ResolvedLeaveType[] = LEAVE_TYPE_DEFAULTS.map((t) => {
    const s = savedByKey.get(t.key);
    const alloc =
      s && typeof s.annualAllocation === 'number' && s.annualAllocation >= 0
        ? Math.round(s.annualAllocation)
        : t.defaultAllocation;
    return {
      key: t.key,
      label: t.label,
      annualAllocation: alloc,
      balanceTracked: t.balanceTracked,
      isLop: t.isLop,
      enabled: s ? s.enabled !== false : true,
      custom: false,
    };
  });

  const customs: ResolvedLeaveType[] = saved
    .filter((s) => !isValidLeaveType(s.key))
    .map((s) => ({
      key: s.key,
      label: (s.label || s.key).trim(),
      annualAllocation:
        typeof s.annualAllocation === 'number' && s.annualAllocation >= 0
          ? Math.round(s.annualAllocation)
          : 0,
      balanceTracked: true,
      isLop: false,
      enabled: s.enabled !== false,
      custom: true,
    }));

  return { leaveTypes: [...standards, ...customs] };
}

/**
 * Canonicalise a submitted config down to the persisted shape. Standard keys keep
 * only {key, annualAllocation, enabled} (label from catalog). Custom keys must be
 * a safe slug with a non-empty label and are stored with it. Dedupes by key; caps
 * the number of custom types.
 */
export function sanitizeLeaveConfig(
  input: { key?: string; label?: string; annualAllocation?: number; enabled?: boolean }[],
): StoredLeaveType[] {
  const seen = new Set<string>();
  const out: StoredLeaveType[] = [];
  let customCount = 0;
  for (const it of input || []) {
    const key = (it.key || '').trim();
    if (!key || seen.has(key)) continue;
    const alloc =
      typeof it.annualAllocation === 'number' && it.annualAllocation >= 0
        ? Math.round(it.annualAllocation)
        : 0;

    if (isValidLeaveType(key)) {
      seen.add(key);
      out.push({ key, annualAllocation: alloc, enabled: it.enabled !== false });
      continue;
    }
    // Custom type — needs a valid slug key + a label, capped.
    const label = (it.label || '').trim();
    if (!CUSTOM_KEY_RE.test(key) || !label || customCount >= MAX_CUSTOM_LEAVE_TYPES) continue;
    seen.add(key);
    customCount++;
    out.push({ key, label: label.slice(0, 60), annualAllocation: alloc, enabled: it.enabled !== false });
  }
  return out;
}
