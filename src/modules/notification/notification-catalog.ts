/**
 * The notification EMAIL registry — the single place that says which
 * notification types also send a branded email, and with what eyebrow + CTA
 * label. `NotifierService.notify()` consults it: a type listed here emails (by
 * default, subject to the recipient's email preferences) using the notification's
 * own title/body; a type not listed is in-app only.
 *
 * Types that already have a RICHER bespoke email (the attendance crons, the
 * onboarding welcome/reminder) are intentionally NOT listed here so recipients
 * never get two emails for one event.
 */
export interface NotificationEmailMeta {
  /** Uppercase label above the title in the email. */
  eyebrow: string;
  /** Button label. Only rendered when the notification carries `data.actionUrl`. */
  cta?: string;
  /** Escaped footer line (optional). */
  footerNote?: string;
}

export const NOTIFICATION_EMAIL: Record<string, NotificationEmailMeta> = {
  // ── Leave ──
  leave_requested: { eyebrow: 'Leave request', cta: 'Review request' },
  leave_approved: { eyebrow: 'Leave approved', cta: 'View leave' },
  leave_rejected: { eyebrow: 'Leave declined', cta: 'View leave' },
  leave_cancelled: { eyebrow: 'Leave cancelled', cta: 'View leave' },

  // ── Timesheet ──
  timesheet_submitted: { eyebrow: 'Timesheet', cta: 'Review timesheet' },
  timesheet_approved: { eyebrow: 'Timesheet approved', cta: 'View timesheet' },
  timesheet_rejected: { eyebrow: 'Timesheet returned', cta: 'View timesheet' },

  // ── Payroll ──
  payroll_payslip_ready: { eyebrow: 'Payslip ready', cta: 'View payslip' },
  tax_declaration_submitted: { eyebrow: 'Declarations', cta: 'Review declaration' },
  tax_declaration_verified: { eyebrow: 'Declarations verified', cta: 'View declaration' },

  // ── Policy ──
  policy_published: { eyebrow: 'New policy', cta: 'Review policy' },
  policy_ack_reminder: { eyebrow: 'Policy reminder', cta: 'Acknowledge now' },

  // ── Employee documents (member onboarding) ──
  onboarding_document_requested: { eyebrow: 'Document requested', cta: 'Provide document' },
  onboarding_document_verified: { eyebrow: 'Document approved', cta: 'View onboarding' },
  onboarding_document_rejected: { eyebrow: 'Document needs changes', cta: 'Re-upload document' },

  // ── WFH ──
  wfh_request_submitted: { eyebrow: 'WFH request', cta: 'Review request' },
  wfh_request_reviewed: { eyebrow: 'WFH request', cta: 'View request' },

  // ── Recruitment ──
  recruitment_candidate_assigned: { eyebrow: 'Recruitment', cta: 'View candidate' },
  recruitment_interview_scheduled: { eyebrow: 'Interview scheduled', cta: 'View interview' },
  recruitment_interview_cancelled: { eyebrow: 'Interview cancelled', cta: 'View interview' },
  recruitment_feedback_due: { eyebrow: 'Interview feedback due', cta: 'Submit feedback' },
  recruitment_offer_accepted: { eyebrow: 'Offer accepted', cta: 'View candidate' },

  // ── Chat ──
  chat_mention: { eyebrow: 'You were mentioned', cta: 'Open conversation' },

  // ── Terms & Conditions ──
  terms_activated: { eyebrow: 'Terms & Conditions', cta: 'Review & accept' },

  // ── Security ──
  security_new_signin: { eyebrow: 'Security alert', cta: 'Review activity' },
  security_mfa_changed: { eyebrow: 'Security', cta: 'Review security' },

  // ── Organization lifecycle ──
  org_suspended: { eyebrow: 'Account status' },
  org_reactivated: { eyebrow: 'Account status', cta: 'Open Nugenova' },
};

export function emailMetaForType(type: string): NotificationEmailMeta | null {
  return NOTIFICATION_EMAIL[type] ?? null;
}

/**
 * Types that ALWAYS deliver — they bypass both the org-level policy and the
 * recipient's personal preferences, because missing one is an account-integrity
 * or lockout risk (a security alert, a required Terms re-accept, a suspension
 * notice). Sign-in codes are sent outside notify() entirely and are always sent.
 */
export const CRITICAL_NOTIFICATION_TYPES = new Set<string>([
  'terms_activated',
  'org_suspended',
  'org_reactivated',
  'security_new_signin',
  'security_mfa_changed',
]);

export function isCriticalNotification(type: string): boolean {
  return CRITICAL_NOTIFICATION_TYPES.has(type);
}

/**
 * The catalog of individual, controllable notification EVENTS — the source of
 * truth for the per-event settings UI. Each entry names one notify() type, a
 * human label, its category, and who it's aimed at ('employee' = the affected
 * person, 'manager' = approvers/HR). Critical types are deliberately absent —
 * they always send and aren't user-controllable.
 */
export interface NotificationTypeMeta {
  type: string;
  label: string;
  category: string;
  audience: 'employee' | 'manager';
}

export const NOTIFICATION_TYPE_CATALOG: NotificationTypeMeta[] = [
  // Attendance
  { type: 'attendance_not_clocked_in', label: 'Missed clock-in reminder', category: 'attendance', audience: 'employee' },
  { type: 'attendance_absent', label: 'Marked absent', category: 'attendance', audience: 'employee' },
  { type: 'attendance_missed_checkout', label: 'Missed check-out', category: 'attendance', audience: 'employee' },
  { type: 'attendance_daily_digest', label: 'Daily attendance digest', category: 'attendance', audience: 'manager' },
  { type: 'attendance_not_clocked_in_summary', label: "Team not-clocked-in summary", category: 'attendance', audience: 'manager' },
  { type: 'wfh_request_submitted', label: 'WFH request submitted', category: 'attendance', audience: 'manager' },
  { type: 'wfh_request_reviewed', label: 'WFH request approved / declined', category: 'attendance', audience: 'employee' },
  // Leave
  { type: 'leave_requested', label: 'Leave request submitted', category: 'leave', audience: 'manager' },
  { type: 'leave_approved', label: 'Leave approved', category: 'leave', audience: 'employee' },
  { type: 'leave_rejected', label: 'Leave declined', category: 'leave', audience: 'employee' },
  { type: 'leave_cancelled', label: 'Leave cancelled', category: 'leave', audience: 'employee' },
  // Timesheet
  { type: 'timesheet_submitted', label: 'Timesheet submitted', category: 'timesheet', audience: 'manager' },
  { type: 'timesheet_approved', label: 'Timesheet approved', category: 'timesheet', audience: 'employee' },
  { type: 'timesheet_rejected', label: 'Timesheet returned', category: 'timesheet', audience: 'employee' },
  // Payroll
  { type: 'payroll_payslip_ready', label: 'Payslip ready', category: 'payroll', audience: 'employee' },
  { type: 'tax_declaration_submitted', label: 'Tax declaration submitted', category: 'payroll', audience: 'manager' },
  { type: 'tax_declaration_verified', label: 'Tax declaration verified', category: 'payroll', audience: 'employee' },
  // Onboarding
  { type: 'onboarding_initiated', label: 'Onboarding started', category: 'onboarding', audience: 'employee' },
  { type: 'onboarding_reminder', label: 'Onboarding reminder', category: 'onboarding', audience: 'employee' },
  { type: 'onboarding_document_requested', label: 'Document requested', category: 'onboarding', audience: 'employee' },
  { type: 'onboarding_document_verified', label: 'Document approved', category: 'onboarding', audience: 'employee' },
  { type: 'onboarding_document_rejected', label: 'Document needs changes', category: 'onboarding', audience: 'employee' },
  // Policy
  { type: 'policy_published', label: 'New policy published', category: 'policy', audience: 'employee' },
  { type: 'policy_ack_reminder', label: 'Policy acknowledgement reminder', category: 'policy', audience: 'employee' },
  // Recruitment
  { type: 'recruitment_candidate_assigned', label: 'Candidate assigned to you', category: 'recruitment', audience: 'manager' },
  { type: 'recruitment_stage_changed', label: 'Candidate moved to a new stage', category: 'recruitment', audience: 'manager' },
  { type: 'recruitment_interview_scheduled', label: 'Interview scheduled', category: 'recruitment', audience: 'employee' },
  { type: 'recruitment_interview_cancelled', label: 'Interview cancelled / rescheduled', category: 'recruitment', audience: 'employee' },
  { type: 'recruitment_feedback_due', label: 'Interview feedback reminder', category: 'recruitment', audience: 'employee' },
  { type: 'recruitment_feedback_submitted', label: 'Interview feedback submitted', category: 'recruitment', audience: 'manager' },
  { type: 'recruitment_offer_accepted', label: 'Offer accepted', category: 'recruitment', audience: 'manager' },
  // Chat
  { type: 'chat_mention', label: 'You were @mentioned', category: 'chat', audience: 'employee' },
];

/** Catalog entries for one category. */
export function typesForCategory(category: string): NotificationTypeMeta[] {
  return NOTIFICATION_TYPE_CATALOG.filter((t) => t.category === category);
}
