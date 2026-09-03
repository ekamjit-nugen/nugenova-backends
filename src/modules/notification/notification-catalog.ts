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
