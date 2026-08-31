/**
 * Leave domain types. The type list + allocations are OWNER-CONFIGURABLE and live
 * in the policy module (`policy/leave-config.ts`, stored on a policy row) — the
 * leave engine resolves them via `PolicyService.getLeaveConfig`. This file only
 * re-exports the stable key set (for DTO validation) and the request lifecycle
 * types; nothing here decides allocations.
 */

export {
  LEAVE_TYPE_KEYS,
  isValidLeaveType,
  type LeaveTypeKey,
  type ResolvedLeaveType,
} from '../policy/leave-config';

/** The half a request applies to when it's a half-day. */
export type HalfDaySlot = 'first_half' | 'second_half';

/** Leave request lifecycle. */
export type LeaveStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
