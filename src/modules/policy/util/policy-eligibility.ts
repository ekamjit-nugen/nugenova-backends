/**
 * Policy eligibility helpers (G-P3 / G-P7).
 *
 * A policy applies to an employee only when it is BOTH within its effective
 * window AND matches the employee's applicability scope. Pure functions so the
 * resolver tiers stay readable and independently testable.
 *
 * Ported verbatim from the Nugenova monolith
 * (attendance/util/policy-eligibility.ts) — the logic is the contract by which
 * attendance resolves which policy governs an employee's clock-in.
 *
 * Nexora mapping note: legacy scoped `specific`/`designation` by HR employee
 * `_id` / designationId. Nexora has no separate HR designation — Role replaced
 * Designation — so the resolver builds this scope as
 * `{ _id: userId, departmentId, designationId: roleId }`. The util itself stays
 * generic and unchanged.
 */

export interface EmployeeScope {
  _id?: string | null;
  departmentId?: string | null;
  designationId?: string | null;
}

/**
 * Is `policy` in effect at instant `now`? `effectiveFrom`/`effectiveTo` are
 * optional; a missing bound is open-ended. `effectiveTo` is treated as
 * inclusive to the END of its calendar day so a policy that expires "on the
 * 5th" is still effective throughout the 5th.
 */
export function isPolicyEffective(
  policy: { effectiveFrom?: Date | string | null; effectiveTo?: Date | string | null },
  now: Date,
): boolean {
  const t = now.getTime();
  if (policy.effectiveFrom) {
    const from = new Date(policy.effectiveFrom).getTime();
    if (Number.isFinite(from) && t < from) return false;
  }
  if (policy.effectiveTo) {
    const to = new Date(policy.effectiveTo);
    if (!isNaN(to.getTime())) {
      // Inclusive end-of-day.
      const end = new Date(to);
      end.setUTCHours(23, 59, 59, 999);
      if (t > end.getTime()) return false;
    }
  }
  return true;
}

/**
 * Does `policy.applicableTo`/`applicableIds` cover this employee?
 *   • all          → everyone
 *   • specific     → applicableIds contains the employee _id (Nexora: userId)
 *   • department   → applicableIds contains the employee departmentId
 *   • designation  → applicableIds contains the employee designationId (Nexora: roleId)
 * Direct per-employee attachment (a higher-priority tier) is handled by the
 * resolver and not re-checked here.
 */
export function matchesApplicability(
  policy: { applicableTo?: string; applicableIds?: string[] },
  emp: EmployeeScope,
): boolean {
  const scope = policy.applicableTo || 'all';
  if (scope === 'all') return true;
  const ids = (policy.applicableIds || []).map(String);
  switch (scope) {
    case 'specific':
      return emp._id != null && ids.includes(String(emp._id));
    case 'department':
      return emp.departmentId != null && ids.includes(String(emp.departmentId));
    case 'designation':
      return emp.designationId != null && ids.includes(String(emp.designationId));
    default:
      return false;
  }
}
