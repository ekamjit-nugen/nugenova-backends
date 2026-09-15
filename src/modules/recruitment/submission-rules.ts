/**
 * Client-lead submissions: statuses and the allowed transitions. Pure — shared by
 * SubmissionsService and its spec (and mirrored in the frontend lib).
 */

export const SUBMISSION_STATUSES = [
  'shortlisted', 'submitted', 'client_screening', 'client_interview', 'client_selected', 'onboarded',
  'client_rejected', 'on_hold', 'withdrawn',
] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

/** Still in play for the client (counts toward "submitted to clients"). */
export const ACTIVE_SUBMISSION_STATUSES: SubmissionStatus[] = [
  'shortlisted', 'submitted', 'client_screening', 'client_interview', 'client_selected', 'on_hold',
];
export const CLOSED_SUBMISSION_STATUSES: SubmissionStatus[] = ['onboarded', 'client_rejected', 'withdrawn'];

export const SUBMISSION_TRANSITIONS: Record<SubmissionStatus, SubmissionStatus[]> = {
  shortlisted: ['submitted', 'on_hold', 'withdrawn'],
  submitted: ['client_screening', 'client_interview', 'client_selected', 'client_rejected', 'on_hold', 'withdrawn'],
  client_screening: ['client_interview', 'client_selected', 'client_rejected', 'on_hold', 'withdrawn'],
  client_interview: ['client_selected', 'client_rejected', 'on_hold', 'withdrawn'],
  client_selected: ['onboarded', 'client_rejected', 'on_hold', 'withdrawn'],
  onboarded: [],
  client_rejected: ['shortlisted'],
  on_hold: ['shortlisted', 'submitted', 'client_screening', 'client_interview', 'client_selected', 'client_rejected', 'withdrawn'],
  withdrawn: ['shortlisted'],
};

/** Moving into these needs a reason (why the client said no / why we pulled out). */
export const SUBMISSION_REASON_REQUIRED: SubmissionStatus[] = ['client_rejected', 'withdrawn'];

export const SUBMISSION_LABEL: Record<SubmissionStatus, string> = {
  shortlisted: 'Shortlisted',
  submitted: 'Shared with client',
  client_screening: 'Client screening',
  client_interview: 'Client interview',
  client_selected: 'Selected by client',
  onboarded: 'Onboarded',
  client_rejected: 'Rejected by client',
  on_hold: 'On hold',
  withdrawn: 'Withdrawn',
};

export const BILL_UNITS = ['hour', 'day', 'month', 'fixed'] as const;
export type BillUnit = (typeof BILL_UNITS)[number];

export type TransitionCheck = { ok: true } | { ok: false; error: string };

export function checkTransition(from: SubmissionStatus, to: SubmissionStatus, reason?: string | null): TransitionCheck {
  if (from === to) return { ok: false, error: `Already ${SUBMISSION_LABEL[to].toLowerCase()}` };
  if (!SUBMISSION_TRANSITIONS[from]?.includes(to)) {
    return { ok: false, error: `Can’t move from “${SUBMISSION_LABEL[from]}” to “${SUBMISSION_LABEL[to]}”` };
  }
  if (SUBMISSION_REASON_REQUIRED.includes(to) && !reason?.trim()) {
    return { ok: false, error: `A reason is required to mark as “${SUBMISSION_LABEL[to]}”` };
  }
  return { ok: true };
}

/**
 * Default cost per bill unit from an annual CTC (India: ~21 working days/month,
 * 8 hours/day). Recruiters can override on the submission.
 */
export function costPerUnitFromAnnual(annual: number | null | undefined, unit: BillUnit): number | null {
  if (annual == null || !Number.isFinite(annual) || annual <= 0) return null;
  const monthly = annual / 12;
  switch (unit) {
    case 'month': return Math.round(monthly);
    case 'day': return Math.round(monthly / 21);
    case 'hour': return Math.round(monthly / 21 / 8);
    default: return null;
  }
}

/** Gross margin % of a bill rate over cost (null when either side is unknown). */
export function marginPct(billRate: number | null | undefined, costRate: number | null | undefined): number | null {
  if (billRate == null || costRate == null || billRate <= 0) return null;
  return Math.round(((billRate - costRate) / billRate) * 1000) / 10;
}
