import {
  activityBackupEmail,
  attendanceAbsentEmail,
  attendanceDigestEmail,
  attendanceMissedCheckoutEmail,
  attendanceNotClockedInEmail,
  clientPortalInviteEmail,
  documentApprovedEmail,
  documentRejectedEmail,
  documentsRequestedEmail,
  emailChangedNoticeEmail,
  onboardingReminderEmail,
  onboardingWelcomeEmail,
  orgInviteEmail,
  otpEmail,
  securityAlertEmail,
} from '../../bootstrap/mail/email-layout';
import { renderErrorAlertEmail } from '../../bootstrap/errors/error-alert-email';
import { SECURITY_ALERT_COPY, SECURITY_ALERT_CTA, SecurityAlertCopy } from '../auth/security-alert-copy';
import { EMAIL_OVERRIDES } from './notification-catalog';
import { EmailOption, renderNotificationEmail } from './notification-email';

/**
 * Every email the product sends — the single list behind the Roles page's email
 * matrix and its previews.
 *
 * Three kinds, because "which roles get this email" means different things:
 *  - `team`     — about other people (a leave request to approve, yesterday's
 *                 attendance). A ticked role RECEIVES it. Defaults: owners, admins.
 *  - `personal` — about the recipient themselves (you were marked absent, your
 *                 payslip is ready). A ticked role's members GET THEIR OWN.
 *                 Defaults: everyone.
 *  - `fixed`    — must always go out: sign-in codes, security alerts, legal and
 *                 suspension notices, the owner's data backup. Not role-routable,
 *                 but still previewable.
 *
 * Previews call the SAME template function the real send does, with sample data,
 * so what an admin sees is what recipients get. For notify()-based emails the
 * layout, eyebrow, button and footer are exact; the title and body are a sample
 * written in the same format as the real call site.
 */
export type EmailKind = 'team' | 'personal' | 'fixed';

export interface EmailPreviewContext {
  orgName: string;
  /** Absolute app origin, used for links in the preview. */
  frontendUrl: string;
}

export interface EmailCatalogEntry {
  /** Stable key: the notify() type, or the mail category for direct sends. */
  key: string;
  label: string;
  group: string;
  kind: EmailKind;
  /** Plain language: who gets it and when. */
  about: string;
  preview: (ctx: EmailPreviewContext) => { subject: string; html: string };
}

const url = (ctx: EmailPreviewContext, path: string) => `${ctx.frontendUrl.replace(/\/+$/, '')}${path}`;

/** Preview for an email sent through NotifierService.notify(). */
const viaNotify =
  (type: string, sample: { title: string; body?: string | null; actionUrl?: string; email?: EmailOption }) =>
  (ctx: EmailPreviewContext) => {
    const built = renderNotificationEmail({
      type,
      title: sample.title,
      body: sample.body ?? null,
      actionUrl: sample.actionUrl,
      email: sample.email,
      absoluteUrl: (path) => (/^https?:\/\//i.test(path) ? path : url(ctx, path.startsWith('/') ? path : `/${path}`)),
    });
    if (!built) throw new Error(`No email is rendered for notification type "${type}"`);
    return built;
  };

const security = (copy: SecurityAlertCopy) => (ctx: EmailPreviewContext) =>
  securityAlertEmail({ ...copy, ctaText: SECURITY_ALERT_CTA.text, ctaUrl: url(ctx, SECURITY_ALERT_CTA.path) });

const SAMPLE_DATE = '16 Sept';

export const EMAIL_CATALOG: EmailCatalogEntry[] = [
  // ── Attendance ────────────────────────────────────────────────────────────
  {
    key: 'attendance.daily_digest',
    label: 'Daily attendance summary',
    group: 'Attendance',
    kind: 'team',
    about: "Every morning (8:30 IST): yesterday's absences, late arrivals, half days and missed check-outs across the whole team.",
    preview: (ctx) =>
      attendanceDigestEmail({ orgName: ctx.orgName, dateLabel: SAMPLE_DATE, absent: 3, late: 2, halfDay: 1, missed: 1, activityUrl: url(ctx, '/attendance/activity') }),
  },
  {
    key: 'wfh_request_submitted',
    label: 'Work-from-home request to review',
    group: 'Attendance',
    kind: 'team',
    about: 'When someone asks to work from home.',
    preview: viaNotify('wfh_request_submitted', { title: 'New work-from-home request', body: 'Priya Nair requested WFH for 18–19 Sept.', actionUrl: '/attendance' }),
  },
  {
    key: 'attendance.absent',
    label: 'You were marked absent',
    group: 'Attendance',
    kind: 'personal',
    about: 'Every morning (8:00 IST), to anyone with no attendance, leave or approved WFH the previous working day.',
    preview: (ctx) => attendanceAbsentEmail({ employeeName: 'Priya', orgName: ctx.orgName, dateLabel: SAMPLE_DATE, attendanceUrl: url(ctx, '/attendance') }),
  },
  {
    key: 'attendance.not_clocked_in',
    label: "You haven't clocked in",
    group: 'Attendance',
    kind: 'personal',
    about: "At 11:00 IST, to anyone who hasn't clocked in yet today.",
    preview: (ctx) => attendanceNotClockedInEmail({ employeeName: 'Priya', orgName: ctx.orgName, attendanceUrl: url(ctx, '/attendance') }),
  },
  {
    key: 'attendance.missed_checkout',
    label: 'Session left open was closed',
    group: 'Attendance',
    kind: 'personal',
    about: 'When a clock-in is left open for 18+ hours and the system closes it.',
    preview: (ctx) =>
      attendanceMissedCheckoutEmail({ employeeName: 'Priya', orgName: ctx.orgName, dateLabel: SAMPLE_DATE, hours: 8, attendanceUrl: url(ctx, '/attendance') }),
  },
  {
    key: 'wfh_request_reviewed',
    label: 'Your work-from-home request was decided',
    group: 'Attendance',
    kind: 'personal',
    about: 'When your WFH request is approved or rejected.',
    preview: viaNotify('wfh_request_reviewed', { title: 'WFH request approved', body: 'Your work-from-home request for 18–19 Sept was approved.', actionUrl: '/attendance' }),
  },

  // ── Leave ─────────────────────────────────────────────────────────────────
  {
    key: 'leave_requested',
    label: 'Leave request to review',
    group: 'Leave',
    kind: 'team',
    about: 'When someone applies for leave.',
    preview: viaNotify('leave_requested', { title: 'Leave request to review', body: 'Priya Nair requested Casual Leave (2 days).', actionUrl: '/leaves' }),
  },
  {
    key: 'leave_approved',
    label: 'Your leave was approved',
    group: 'Leave',
    kind: 'personal',
    about: 'When your leave request is approved.',
    preview: viaNotify('leave_approved', { title: 'Leave approved', body: 'Your Casual Leave for 15–17 Sept was approved.', actionUrl: '/leaves' }),
  },
  {
    key: 'leave_rejected',
    label: 'Your leave was declined',
    group: 'Leave',
    kind: 'personal',
    about: 'When your leave request is declined.',
    preview: viaNotify('leave_rejected', { title: 'Leave declined', body: 'Your Sick Leave for 8 Sept was declined. Tap for details.', actionUrl: '/leaves' }),
  },
  {
    key: 'leave_cancelled',
    label: 'A leave you approved was cancelled',
    group: 'Leave',
    kind: 'personal',
    about: 'To whoever approved a leave, when the employee cancels it.',
    preview: viaNotify('leave_cancelled', { title: 'Leave cancelled', body: 'Priya Nair cancelled their Casual Leave.', actionUrl: '/leaves' }),
  },

  // ── Timesheets ────────────────────────────────────────────────────────────
  {
    key: 'timesheet_submitted',
    label: 'Timesheet to review',
    group: 'Timesheets',
    kind: 'team',
    about: 'When someone submits a timesheet.',
    preview: viaNotify('timesheet_submitted', { title: 'Timesheet submitted', body: 'An employee submitted their 8–14 Sept timesheet (40h).', actionUrl: '/timesheets' }),
  },
  {
    key: 'timesheet_approved',
    label: 'Your timesheet was approved',
    group: 'Timesheets',
    kind: 'personal',
    about: 'When your timesheet is approved.',
    preview: viaNotify('timesheet_approved', { title: 'Timesheet approved', body: 'Your 8–14 Sept timesheet was approved.', actionUrl: '/timesheets' }),
  },
  {
    key: 'timesheet_rejected',
    label: 'Your timesheet was returned',
    group: 'Timesheets',
    kind: 'personal',
    about: 'When your timesheet is sent back for changes.',
    preview: viaNotify('timesheet_rejected', { title: 'Timesheet returned', body: 'Your 8–14 Sept timesheet was returned for changes.', actionUrl: '/timesheets' }),
  },

  // ── Payroll ───────────────────────────────────────────────────────────────
  {
    key: 'tax_declaration_submitted',
    label: 'Tax declaration to review',
    group: 'Payroll',
    kind: 'team',
    about: 'When someone submits their investment declaration.',
    preview: viaNotify('tax_declaration_submitted', { title: 'Tax declaration submitted', body: 'An employee submitted their FY 2026–27 investment declaration for review.', actionUrl: '/payroll/declarations' }),
  },
  {
    key: 'payroll_payslip_ready',
    label: 'Your payslip is ready',
    group: 'Payroll',
    kind: 'personal',
    about: 'When your payslip is generated.',
    preview: viaNotify('payroll_payslip_ready', { title: 'Your payslip is ready', body: 'Your August 2026 payslip is now available to download.', actionUrl: '/payroll' }),
  },
  {
    key: 'tax_declaration_verified',
    label: 'Your tax declaration was recorded',
    group: 'Payroll',
    kind: 'personal',
    about: 'When payroll records or verifies your declaration.',
    preview: viaNotify('tax_declaration_verified', { title: 'Tax declaration updated', body: 'Your FY 2026–27 tax declaration was recorded by payroll and applies to your income tax.', actionUrl: '/payroll/my' }),
  },

  // ── Onboarding ────────────────────────────────────────────────────────────
  {
    key: 'onboarding.welcome',
    label: 'Welcome to onboarding',
    group: 'Onboarding',
    kind: 'personal',
    about: "When a new hire's onboarding is started.",
    preview: (ctx) =>
      onboardingWelcomeEmail({ employeeName: 'Priya', orgName: ctx.orgName, documentTitles: ['PAN card', 'Address proof'], taskTitles: ['Sign offer letter'], onboardingUrl: url(ctx, '/onboarding/me') }),
  },
  {
    key: 'onboarding.reminder',
    label: 'Onboarding items still pending',
    group: 'Onboarding',
    kind: 'personal',
    about: 'Daily (10:00), while a new hire still has onboarding items outstanding.',
    preview: (ctx) => onboardingReminderEmail({ employeeName: 'Priya', orgName: ctx.orgName, pendingTitles: ['Address proof'], onboardingUrl: url(ctx, '/onboarding/me') }),
  },
  {
    key: 'onboarding_document_requested',
    label: 'A document was requested from you',
    group: 'Onboarding',
    kind: 'personal',
    about: 'When HR asks you for a document.',
    preview: viaNotify('onboarding_document_requested', { title: 'A document was requested from you', body: 'Please provide "Address proof" in My Onboarding.', actionUrl: '/onboarding/me' }),
  },
  {
    key: 'onboarding_document_verified',
    label: 'Your document was approved',
    group: 'Onboarding',
    kind: 'personal',
    about: 'When a document you uploaded is approved.',
    preview: viaNotify('onboarding_document_verified', { title: 'Onboarding document approved', body: 'Your "PAN card" was approved.', actionUrl: '/onboarding/me' }),
  },
  {
    key: 'onboarding_document_rejected',
    label: 'Your document needs changes',
    group: 'Onboarding',
    kind: 'personal',
    about: 'When a document you uploaded is rejected.',
    preview: viaNotify('onboarding_document_rejected', { title: 'Document needs changes', body: 'Your "Address proof" was rejected — please re-upload it.', actionUrl: '/onboarding/me' }),
  },

  // ── Policies ──────────────────────────────────────────────────────────────
  {
    key: 'policy_published',
    label: 'New policy to acknowledge',
    group: 'Policies',
    kind: 'personal',
    about: 'When a policy that applies to you is published.',
    preview: viaNotify('policy_published', { title: 'New policy to acknowledge', body: 'Please review and acknowledge the Work From Office policy.', actionUrl: '/policies' }),
  },
  {
    key: 'policy_ack_reminder',
    label: 'Policy acknowledgement reminder',
    group: 'Policies',
    kind: 'personal',
    about: 'When an admin sends a reminder about policies you have not acknowledged.',
    preview: viaNotify('policy_ack_reminder', { title: 'Reminder: acknowledge your policies', body: 'You still have 1 policy waiting for your acknowledgement.', actionUrl: '/policies' }),
  },

  // ── Recruitment ───────────────────────────────────────────────────────────
  {
    key: 'recruitment_candidate_assigned',
    label: 'A candidate was assigned to you',
    group: 'Recruitment',
    kind: 'personal',
    about: 'When you become the owner of a candidate.',
    preview: viaNotify('recruitment_candidate_assigned', { title: 'You own a candidate: Arjun Mehta', body: 'Senior Backend Engineer · Acme Retail', actionUrl: '/recruitment/candidates' }),
  },
  {
    key: 'recruitment_interview_scheduled',
    label: 'Interview scheduled',
    group: 'Recruitment',
    kind: 'personal',
    about: "To interviewers, when they're added to an interview.",
    preview: viaNotify('recruitment_interview_scheduled', { title: 'Interview: Arjun Mehta — Technical round', body: 'Backend Engineer · 18 Sept, 3:00 PM IST', actionUrl: '/recruitment/interviews' }),
  },
  {
    key: 'recruitment_interview_cancelled',
    label: 'Interview cancelled or rescheduled',
    group: 'Recruitment',
    kind: 'personal',
    about: 'To interviewers, when an interview is cancelled or moved.',
    preview: viaNotify('recruitment_interview_cancelled', { title: 'Interview: Arjun Mehta — Technical round', body: '19 Sept, 11:00 AM IST', actionUrl: '/recruitment/interviews' }),
  },
  {
    key: 'recruitment_feedback_due',
    label: 'Interview feedback due',
    group: 'Recruitment',
    kind: 'personal',
    about: "To interviewers who haven't submitted feedback in time.",
    preview: viaNotify('recruitment_feedback_due', { title: 'Feedback due: Arjun Mehta — Technical round', body: null, actionUrl: '/recruitment/interviews' }),
  },
  {
    key: 'recruitment_offer_accepted',
    label: 'Offer accepted',
    group: 'Recruitment',
    kind: 'personal',
    about: 'To the candidate owner, hiring manager and offer creator.',
    preview: viaNotify('recruitment_offer_accepted', { title: 'Arjun Mehta accepted the offer', body: 'Senior Backend Engineer · Backend Engineer', actionUrl: '/recruitment/offers' }),
  },
  {
    key: 'recruitment_submission_created',
    label: 'Candidate submitted to your lead',
    group: 'Recruitment',
    kind: 'personal',
    about: "To the lead's assignee, when a candidate is shared with the client.",
    preview: viaNotify('recruitment_submission_created', { title: 'Arjun Mehta shared with Acme Retail', body: null, actionUrl: '/recruitment/leads' }),
  },
  {
    key: 'recruitment_submission_decision',
    label: 'Client decision on a candidate',
    group: 'Recruitment',
    kind: 'personal',
    about: 'When a client shortlists, interviews, selects or rejects a submitted candidate.',
    preview: viaNotify('recruitment_submission_decision', { title: 'Arjun Mehta: Shortlisted', body: 'Acme Retail', actionUrl: '/recruitment/leads' }),
  },

  // ── Sales ─────────────────────────────────────────────────────────────────
  {
    key: 'lead_assigned',
    label: 'A lead was assigned to you',
    group: 'Sales',
    kind: 'personal',
    about: 'When someone else assigns you a sales lead.',
    preview: viaNotify('lead_assigned', { title: "You've been assigned a lead: Priya Nair", body: 'Acme Retail', actionUrl: '/sales/leads', email: EMAIL_OVERRIDES.leadAssigned }),
  },

  // ── Clients ───────────────────────────────────────────────────────────────
  {
    key: 'client_agreement_signed',
    label: 'Client signed an agreement',
    group: 'Clients',
    kind: 'personal',
    about: "To the agreement's creator and the people assigned to that client.",
    preview: viaNotify('client_agreement_signed', {
      title: 'Rohan Kapoor signed “Master Services Agreement”',
      body: 'Acme Retail signed the agreement “Master Services Agreement”.',
      actionUrl: '/clients',
      email: EMAIL_OVERRIDES.agreementSigned('Acme Retail', 'Master Services Agreement'),
    }),
  },
  {
    key: 'client_ticket_created',
    label: 'New client support request',
    group: 'Clients',
    kind: 'personal',
    about: "To the people assigned to the client (or the client's portal users when your team raises it). Role choices apply to your staff only.",
    preview: viaNotify('client_ticket_created', { title: 'New request from Acme Retail: Invoice query', body: 'Could you resend the August invoice?', actionUrl: '/clients', email: EMAIL_OVERRIDES.supportRequest }),
  },
  {
    key: 'client_ticket_reply',
    label: 'Reply on a client support request',
    group: 'Clients',
    kind: 'personal',
    about: 'When there is a new reply on a support request you are part of. Role choices apply to your staff only.',
    preview: viaNotify('client_ticket_reply', { title: 'Reply from Acme Retail: Invoice query', body: 'Thanks — received it.', actionUrl: '/clients', email: EMAIL_OVERRIDES.supportRequest }),
  },
  {
    key: 'client_agreement_reminder',
    label: 'Signature reminder to a client',
    group: 'Clients',
    kind: 'fixed',
    about: "Sent to the client's portal users (not your staff) every 3 days until they sign, up to 3 times.",
    preview: viaNotify('client_agreement_reminder', {
      title: 'Reminder: please sign “Master Services Agreement”',
      body: 'Nugen IT Services is waiting for your signature on “Master Services Agreement”.',
      actionUrl: '/portal/agreements',
      email: EMAIL_OVERRIDES.agreementSignRequest('Master Services Agreement'),
    }),
  },
  {
    key: 'clients.portal_invite',
    label: 'Client portal invitation',
    group: 'Clients',
    kind: 'fixed',
    about: "Sent to a client's contact when they're invited to the client portal.",
    preview: () => clientPortalInviteEmail({ contactName: 'Rohan Kapoor', companyName: 'Acme Retail' }),
  },

  // ── Chat ──────────────────────────────────────────────────────────────────
  {
    key: 'chat_mention',
    label: 'You were @mentioned',
    group: 'Chat',
    kind: 'personal',
    about: "When someone @mentions you in chat while you're offline.",
    preview: viaNotify('chat_mention', { title: 'Priya Nair mentioned you', body: '@you can you review the release notes?', actionUrl: '/chat' }),
  },

  // ── Account & security (always sent) ──────────────────────────────────────
  {
    key: 'otp',
    label: 'Sign-in code',
    group: 'Account & security',
    kind: 'fixed',
    about: 'Every time someone signs in.',
    preview: () => otpEmail({ otp: '482913', expiresMinutes: 10 }),
  },
  {
    key: 'security.new_signin',
    label: 'New sign-in alert',
    group: 'Account & security',
    kind: 'fixed',
    about: 'When an account is used from a device it has not been used on before.',
    preview: security(SECURITY_ALERT_COPY.newSignin({ label: 'Chrome on macOS', ipAddress: '203.0.113.7', when: 'Wed, 17 Sep 2026 06:42:25 GMT' })),
  },
  {
    key: 'security.mfa_enabled',
    label: 'Two-factor authentication turned on',
    group: 'Account & security',
    kind: 'fixed',
    about: 'When a user turns on two-factor authentication.',
    preview: security(SECURITY_ALERT_COPY.mfaEnabled()),
  },
  {
    key: 'security.mfa_disabled',
    label: 'Two-factor authentication turned off',
    group: 'Account & security',
    kind: 'fixed',
    about: 'When a user turns off two-factor authentication.',
    preview: security(SECURITY_ALERT_COPY.mfaDisabled()),
  },
  {
    key: 'security.email_changed',
    label: 'Sign-in email changed',
    group: 'Account & security',
    kind: 'fixed',
    about: "To a member's previous address when an admin changes their sign-in email.",
    preview: (ctx) =>
      emailChangedNoticeEmail({ name: 'Priya', orgName: ctx.orgName, oldEmail: 'priya.old@example.com', newEmail: 'priya@example.com', when: 'Sep 17, 2026, 12:10 PM' }),
  },

  // ── Organization (always sent) ────────────────────────────────────────────
  {
    key: 'terms_activated',
    label: 'Updated Terms & Conditions',
    group: 'Organization',
    kind: 'fixed',
    about: 'To owners and admins when the platform Terms & Conditions change and must be accepted again.',
    preview: viaNotify('terms_activated', { title: 'Updated Terms & Conditions', body: 'The platform Terms & Conditions have been updated. Please review and accept them to keep using Nugen IT Services.', actionUrl: '/consent' }),
  },
  {
    key: 'org_suspended',
    label: 'Organization suspended',
    group: 'Organization',
    kind: 'fixed',
    about: 'To owners and admins when the platform suspends the organization.',
    preview: viaNotify('org_suspended', { title: 'Your organization has been suspended', body: 'Nugen IT Services has been suspended by the platform administrator. Please contact support to restore access.' }),
  },
  {
    key: 'org_reactivated',
    label: 'Organization reactivated',
    group: 'Organization',
    kind: 'fixed',
    about: 'To owners and admins when a suspended organization is restored.',
    preview: viaNotify('org_reactivated', { title: 'Your organization is active again', body: 'Nugen IT Services has been reactivated. Your team can sign in and use the platform again.', actionUrl: '/dashboard' }),
  },
  {
    key: 'org-invite',
    label: 'Owner invitation',
    group: 'Organization',
    kind: 'fixed',
    about: 'To the owner of a newly created organization.',
    preview: (ctx) => orgInviteEmail({ orgName: ctx.orgName, ownerName: 'Varun', ownerEmail: 'owner@example.com', loginUrl: url(ctx, '/login') }),
  },
  {
    key: 'onboarding.documents_requested',
    label: 'Company documents requested',
    group: 'Organization',
    kind: 'fixed',
    about: 'To the owner, when the platform asks the organization for its company documents.',
    preview: (ctx) => documentsRequestedEmail({ orgName: ctx.orgName, documentTitles: ['Certificate of incorporation', 'GST certificate'], submitUrl: url(ctx, '/onboarding') }),
  },
  {
    key: 'onboarding.document_approved',
    label: 'Company document approved',
    group: 'Organization',
    kind: 'fixed',
    about: "To the owner, when the platform approves one of the organization's documents.",
    preview: (ctx) => documentApprovedEmail({ orgName: ctx.orgName, documentTitle: 'GST certificate', remaining: 1, submitUrl: url(ctx, '/onboarding') }),
  },
  {
    key: 'onboarding.document_rejected',
    label: 'Company document rejected',
    group: 'Organization',
    kind: 'fixed',
    about: "To the owner, when the platform rejects one of the organization's documents.",
    preview: (ctx) => documentRejectedEmail({ orgName: ctx.orgName, documentTitle: 'GST certificate', note: 'The scan is unreadable — please upload a clearer copy.', submitUrl: url(ctx, '/onboarding') }),
  },
  {
    key: 'activity.retention_backup',
    label: 'Activity log backup',
    group: 'Organization',
    kind: 'fixed',
    about: "Daily, to the owner: activity older than 15 days, archived as an attached zip before it's removed.",
    preview: () => activityBackupEmail({ count: 128, retentionDays: 15, cutoffLabel: '2026-09-02' }),
  },
  {
    key: 'error-alert',
    label: 'Server error alert',
    group: 'Organization',
    kind: 'fixed',
    about: 'To the owner and the ops address when a request fails with a server error (at most once per 15 minutes per fault).',
    preview: () =>
      renderErrorAlertEmail({
        reference: '80cf695b',
        status: 500,
        method: 'GET',
        path: '/api/v1/attendance/activity',
        message: 'invalid input syntax for type timestamp with time zone',
        stack: 'QueryFailedError: invalid input syntax for type timestamp with time zone\n    at PostgresQueryRunner.query (typeorm/driver/postgres/PostgresQueryRunner.ts:299:19)',
        organizationId: '6a9fbcc377bf257f21e4b402',
        userId: null,
        userEmail: 'priya@example.com',
        ip: '203.0.113.7',
        at: new Date('2026-09-17T06:42:25Z'),
      }),
  },
];

const BY_KEY = new Map(EMAIL_CATALOG.map((e) => [e.key, e]));

export function emailCatalogEntry(key: string): EmailCatalogEntry | undefined {
  return BY_KEY.get(key);
}

/** The kind of email a key is, or null for a key that isn't in the catalog. */
export function emailKind(key: string): EmailKind | null {
  return BY_KEY.get(key)?.kind ?? null;
}
