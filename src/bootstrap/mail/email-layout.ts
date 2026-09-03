/**
 * Branded email layout + the onboarding email templates.
 *
 * Ported faithfully from the Nugenova monolith's inline HTML system (there was no
 * template engine — every email was a table-based HTML string). The shared shell
 * that was duplicated per feature there is promoted here into ONE builder,
 * `renderBrandedEmail`, matching the monolith's visual system exactly:
 *   grey canvas #F3F4F6 · white 520px card · colored header band · escaped
 *   title/body · CTA button · copy-paste fallback link · muted footer.
 * Brand accent is Nugenova blue #2E86C1.
 */

export const BRAND_BLUE = '#2E86C1';
const BRAND_BLUE_DARK = '#2874A6';
const INK = '#0F172A';
const INK_SOFT = '#475569';
const MUTED = '#94A3B8';
const CANVAS = '#EEF2F6';
const HAIRLINE = '#E9EEF3';

/**
 * The Nugenova logo lockup as pure, email-safe HTML (a rounded "N" mark + the
 * "nugen·ova" wordmark). No image — so it renders identically with images
 * blocked, the common inbox default.
 */
function logoLockup(): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="vertical-align:middle;">
        <div style="width:34px;height:34px;border-radius:9px;background:${BRAND_BLUE};text-align:center;">
          <span style="display:inline-block;line-height:34px;color:#FFFFFF;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:20px;font-weight:700;">N</span>
        </div>
      </td>
      <td style="vertical-align:middle;padding-left:10px;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:20px;font-weight:700;letter-spacing:-0.01em;color:${INK};">nugen<span style="color:${BRAND_BLUE};">ova</span></td>
    </tr></table>`;
}

/** HTML-escape dynamic text (mirrors the monolith's local esc()). */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface BrandedEmailOptions {
  eyebrow: string;
  title: string;
  /** Pre-escaped / trusted inner HTML for the body paragraph area. */
  bodyHtml: string;
  ctaText?: string;
  ctaUrl?: string;
  accent?: string;
  /** Extra muted line above the copyright (optional). */
  footerNote?: string;
  year?: number;
  /** Hidden inbox-preview text shown after the subject in most clients. */
  preheader?: string;
}

/**
 * The one shared shell. `bodyHtml` is inserted verbatim (callers assemble it from
 * esc()'d fragments); everything else is escaped here.
 */
export function renderBrandedEmail(opts: BrandedEmailOptions): string {
  const accent = opts.accent || BRAND_BLUE;
  const accentDark = accent === BRAND_BLUE ? BRAND_BLUE_DARK : accent;
  const year = opts.year || new Date().getFullYear();
  const cta =
    opts.ctaText && opts.ctaUrl
      ? `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:28px;"><tr><td align="center">
              <a href="${opts.ctaUrl}" style="display:inline-block;background:${accent};background-image:linear-gradient(180deg,${accent},${accentDark});color:#FFFFFF;font-size:15px;font-weight:600;text-decoration:none;padding:13px 34px;border-radius:10px;box-shadow:0 1px 2px rgba(15,23,42,0.12);">${esc(
                opts.ctaText,
              )}</a>
            </td></tr></table>
            <p style="margin:20px 0 0;font-size:12px;line-height:1.5;color:${MUTED};">
              Button not working? Paste this link into your browser:<br/>
              <a href="${opts.ctaUrl}" style="color:${accent};word-break:break-all;">${opts.ctaUrl}</a>
            </p>`
      : '';
  const footerNote = opts.footerNote
    ? `<p style="margin:0 0 8px;font-size:12px;line-height:1.5;color:${MUTED};">${esc(opts.footerNote)}</p>`
    : '';
  const preheader = opts.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${CANVAS};">${esc(
        opts.preheader,
      )}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light only">
  <meta name="supported-color-schemes" content="light only">
  <title>${esc(opts.title)}</title>
  <style>
    @media only screen and (max-width:600px){
      .np-card{width:100% !important;border-radius:0 !important;}
      .np-pad{padding-left:24px !important;padding-right:24px !important;}
    }
    a{text-decoration:none;}
  </style>
</head>
<body style="margin:0;padding:0;background:${CANVAS};font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  ${preheader}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CANVAS};padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" class="np-card" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#FFFFFF;border:1px solid ${HAIRLINE};border-radius:16px;overflow:hidden;box-shadow:0 8px 24px rgba(15,23,42,0.06);">
        <tr>
          <td class="np-pad" style="padding:26px 40px 22px;border-bottom:1px solid ${HAIRLINE};">
            ${logoLockup()}
          </td>
        </tr>
        <tr>
          <td class="np-pad" style="padding:30px 40px 34px;">
            <div style="font-size:11px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;color:${accent};">${esc(
              opts.eyebrow,
            )}</div>
            <h1 style="margin:8px 0 14px;font-size:22px;line-height:1.3;font-weight:700;letter-spacing:-0.01em;color:${INK};">${esc(
              opts.title,
            )}</h1>
            <div style="margin:0;font-size:15px;line-height:1.65;color:${INK_SOFT};">${opts.bodyHtml}</div>${cta}
          </td>
        </tr>
        <tr>
          <td class="np-pad" style="padding:20px 40px 26px;border-top:1px solid ${HAIRLINE};background:#FAFCFE;text-align:center;">
            ${footerNote}
            <p style="margin:0;font-size:12px;color:${MUTED};">&copy; ${year} Nugenova &middot; This is an automated message, please don't reply.</p>
          </td>
        </tr>
      </table>
      <p style="margin:16px 0 0;font-size:11px;color:${MUTED};">Sent by Nugenova to keep your workspace moving.</p>
    </td></tr>
  </table>
</body>
</html>`;
}

/** A compact list of requested documents, rendered as escaped rows. */
function docListHtml(docTitles: string[]): string {
  if (!docTitles.length) return '';
  const rows = docTitles
    .map(
      (t) =>
        `<tr><td style="padding:8px 0;border-bottom:1px solid #F1F5F9;font-size:14px;color:#111827;">&#8226;&nbsp;${esc(
          t,
        )}</td></tr>`,
    )
    .join('');
  return `<table cellpadding="0" cellspacing="0" width="100%" style="margin-top:18px;">${rows}</table>`;
}

// ── Generic notification email ───────────────────────────────────────────────

/**
 * The default email for a notification that has no bespoke template. The
 * NotifierService feeds it the notification's own title/body plus a per-type
 * eyebrow + CTA, so every notification email is consistent by construction.
 * `body` is plain text (escaped here) unless `bodyHtml` is given.
 */
export function notificationEmail(params: {
  eyebrow: string;
  title: string;
  body?: string | null;
  bodyHtml?: string;
  ctaText?: string;
  ctaUrl?: string;
  footerNote?: string;
}): { subject: string; html: string } {
  const bodyHtml =
    params.bodyHtml ??
    (params.body
      ? `<p style="margin:0;">${esc(params.body)}</p>`
      : '<p style="margin:0;">You have a new update in Nugenova.</p>');
  return {
    subject: params.title,
    html: renderBrandedEmail({
      eyebrow: params.eyebrow,
      title: params.title,
      preheader: params.body ?? params.title,
      bodyHtml,
      ctaText: params.ctaText,
      ctaUrl: params.ctaUrl,
      footerNote: params.footerNote,
    }),
  };
}

// ── Security alerts ──────────────────────────────────────────────────────────

/**
 * A security-event alert (new sign-in, MFA change). Renders the event details as
 * a small labelled table and a reassuring "wasn't you?" footer.
 */
export function securityAlertEmail(params: {
  title: string;
  intro: string;
  rows?: Array<{ label: string; value: string }>;
  ctaText?: string;
  ctaUrl?: string;
}): { subject: string; html: string } {
  const detail =
    params.rows && params.rows.length
      ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:16px;border:1px solid #E9EEF3;border-radius:10px;">${params.rows
          .map(
            (r, i) =>
              `<tr><td style="padding:10px 14px;font-size:13px;color:#94A3B8;${i ? 'border-top:1px solid #F1F5F9;' : ''}width:34%;">${esc(
                r.label,
              )}</td><td style="padding:10px 14px;font-size:13px;font-weight:600;color:#0F172A;${i ? 'border-top:1px solid #F1F5F9;' : ''}">${esc(
                r.value,
              )}</td></tr>`,
          )
          .join('')}</table>`
      : '';
  return {
    subject: params.title,
    html: renderBrandedEmail({
      eyebrow: 'Security',
      title: params.title,
      preheader: params.intro,
      bodyHtml: `<p style="margin:0;">${esc(params.intro)}</p>${detail}`,
      ctaText: params.ctaText,
      ctaUrl: params.ctaUrl,
      footerNote:
        "If this was you, no action is needed. If you don't recognise this, change your access and contact your administrator right away.",
    }),
  };
}

// ── Sign-in code (OTP) ───────────────────────────────────────────────────────

/**
 * The passwordless sign-in code. The most-seen email in the product, so it wears
 * the same branded shell as everything else, with the code in a prominent,
 * copy-friendly, letter-spaced block.
 */
export function otpEmail(params: {
  otp: string;
  expiresMinutes?: number;
}): { subject: string; html: string } {
  const mins = params.expiresMinutes ?? 10;
  const code = esc(params.otp);
  const bodyHtml = `
    <p style="margin:0 0 20px;">Use this code to finish signing in. It expires in ${mins} minutes.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center">
      <div style="display:inline-block;background:#EFF6FF;border:1px solid #DCEAF7;border-radius:12px;padding:18px 28px;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:34px;font-weight:700;letter-spacing:10px;color:${BRAND_BLUE};">${code}</div>
    </td></tr></table>`;
  return {
    subject: `${params.otp} is your Nugenova sign-in code`,
    html: renderBrandedEmail({
      eyebrow: 'Sign in',
      title: 'Your sign-in code',
      preheader: `${params.otp} — your Nugenova sign-in code (expires in ${mins} min).`,
      bodyHtml,
      footerNote: "Didn't try to sign in? You can safely ignore this email — no one can sign in without this code.",
    }),
  };
}

// ── Organization invite ──────────────────────────────────────────────────────

/**
 * Sent to the owner when a super admin provisions their organization: invites
 * them to sign in (passwordless) and set the org up.
 */
export function orgInviteEmail(params: {
  orgName: string;
  ownerName?: string;
  ownerEmail: string;
  loginUrl: string;
}): { subject: string; html: string } {
  const greeting = params.ownerName ? `Hi ${esc(params.ownerName)},` : 'Hello,';
  const bodyHtml = `
    <p style="margin:0 0 12px;">${greeting}</p>
    <p style="margin:0 0 12px;">You've been invited to administer
      <strong style="color:#111827;">${esc(params.orgName)}</strong> on Nugenova.</p>
    <p style="margin:0 0 12px;">Sign in with your email
      (<strong style="color:#111827;">${esc(params.ownerEmail)}</strong>) to accept the
      Terms &amp; Conditions and set up your organization — departments, roles, and
      your team. No password is needed; we'll email you a one-time code each time
      you sign in.</p>`;
  return {
    subject: `You're invited to set up ${params.orgName} on Nugenova`,
    html: renderBrandedEmail({
      eyebrow: "You're invited",
      title: `Set up ${params.orgName} on Nugenova`,
      bodyHtml,
      ctaText: 'Sign in to get started',
      ctaUrl: params.loginUrl,
      footerNote:
        'You are receiving this because your organization was created on Nugenova and you were named its administrator.',
    }),
  };
}

// ── Onboarding templates ─────────────────────────────────────────────────────

export function documentsRequestedEmail(params: {
  orgName: string;
  documentTitles: string[];
  submitUrl: string;
}): { subject: string; html: string } {
  const bodyHtml = `
    <p style="margin:0 0 12px;">Welcome to Nugenova. Before <strong style="color:#111827;">${esc(
      params.orgName,
    )}</strong> can go live, our team needs a few documents from you to complete verification.</p>
    <p style="margin:0;">Please sign in to the secure onboarding portal and submit the documents listed below. Some require a signature — you can sign them right in your browser.</p>
    ${docListHtml(params.documentTitles)}`;
  return {
    subject: `Action needed: submit onboarding documents for ${params.orgName}`,
    html: renderBrandedEmail({
      eyebrow: 'Onboarding',
      title: 'A few documents to get you started',
      bodyHtml,
      ctaText: 'Submit documents',
      ctaUrl: params.submitUrl,
      footerNote: 'You are receiving this because your organization is being onboarded to Nugenova.',
    }),
  };
}

export function documentReminderEmail(params: {
  orgName: string;
  pendingTitles: string[];
  submitUrl: string;
}): { subject: string; html: string } {
  const bodyHtml = `
    <p style="margin:0 0 12px;">This is a friendly reminder that <strong style="color:#111827;">${esc(
      params.orgName,
    )}</strong> still has documents awaiting submission. Your organization can't be activated until they're received and approved.</p>
    <p style="margin:0;">Still outstanding:</p>
    ${docListHtml(params.pendingTitles)}`;
  return {
    subject: `Reminder: ${params.pendingTitles.length} document(s) still needed for ${params.orgName}`,
    html: renderBrandedEmail({
      eyebrow: 'Onboarding reminder',
      title: 'Your onboarding is almost there',
      bodyHtml,
      ctaText: 'Finish submitting',
      ctaUrl: params.submitUrl,
      accent: '#F59E0B',
    }),
  };
}

export function documentApprovedEmail(params: {
  orgName: string;
  documentTitle: string;
  remaining: number;
  submitUrl: string;
}): { subject: string; html: string } {
  const bodyHtml = `
    <p style="margin:0 0 12px;">Good news — <strong style="color:#111827;">${esc(
      params.documentTitle,
    )}</strong> has been reviewed and approved.</p>
    <p style="margin:0;">${
      params.remaining > 0
        ? `${params.remaining} document(s) still need to be approved before ${esc(
            params.orgName,
          )} goes live.`
        : `That was the last one — your organization is being activated now.`
    }</p>`;
  return {
    subject: `Approved: ${params.documentTitle}`,
    html: renderBrandedEmail({
      eyebrow: 'Onboarding',
      title: 'A document was approved',
      bodyHtml,
      ctaText: 'View onboarding',
      ctaUrl: params.submitUrl,
      accent: '#059669',
    }),
  };
}

export function documentRejectedEmail(params: {
  orgName: string;
  documentTitle: string;
  note?: string;
  submitUrl: string;
}): { subject: string; html: string } {
  const reason = params.note
    ? `<div style="margin-top:16px;padding:12px 16px;background:#FEF2F2;border-left:3px solid #DC2626;border-radius:6px;font-size:14px;color:#7F1D1D;">${esc(
        params.note,
      )}</div>`
    : '';
  const bodyHtml = `
    <p style="margin:0 0 12px;"><strong style="color:#111827;">${esc(
      params.documentTitle,
    )}</strong> needs another look before it can be approved.</p>
    <p style="margin:0;">Please review the note below, then re-submit the corrected document from the onboarding portal.</p>
    ${reason}`;
  return {
    subject: `Action needed: re-submit ${params.documentTitle}`,
    html: renderBrandedEmail({
      eyebrow: 'Onboarding',
      title: 'A document needs to be re-submitted',
      bodyHtml,
      ctaText: 'Re-submit document',
      ctaUrl: params.submitUrl,
      accent: '#DC2626',
    }),
  };
}

export function orgActivatedEmail(params: {
  orgName: string;
  loginUrl: string;
}): { subject: string; html: string } {
  const bodyHtml = `
    <p style="margin:0 0 12px;">Congratulations — every onboarding document for <strong style="color:#111827;">${esc(
      params.orgName,
    )}</strong> has been approved and your organization is now <strong style="color:#059669;">active</strong>.</p>
    <p style="margin:0;">You now have full access to Nugenova. Sign in to set up your departments, roles, and team.</p>`;
  return {
    subject: `${params.orgName} is live on Nugenova 🎉`,
    html: renderBrandedEmail({
      eyebrow: 'Welcome aboard',
      title: `${params.orgName} is ready to go`,
      bodyHtml,
      ctaText: 'Open Nugenova',
      ctaUrl: params.loginUrl,
      accent: '#059669',
    }),
  };
}

// ── Employee onboarding lifecycle ────────────────────────────────────────────

/** Sent to a new hire the moment HR initiates their onboarding. */
export function onboardingWelcomeEmail(params: {
  employeeName?: string | null;
  orgName: string;
  documentTitles: string[];
  taskTitles: string[];
  onboardingUrl: string;
}): { subject: string; html: string } {
  const greeting = params.employeeName ? `Hi ${esc(params.employeeName)},` : 'Welcome!';
  const items = [...params.documentTitles, ...params.taskTitles];
  const bodyHtml = `
    <p style="margin:0 0 12px;">${greeting}</p>
    <p style="margin:0 0 12px;">Welcome to <strong style="color:#111827;">${esc(
      params.orgName,
    )}</strong>! We're excited to have you. To get you set up, please complete your onboarding — upload the requested documents and tick off your welcome tasks.</p>
    ${items.length ? `<p style="margin:0;">Here's what's waiting for you:</p>${docListHtml(items)}` : ''}`;
  return {
    subject: `Welcome to ${params.orgName} — let's get you onboarded`,
    html: renderBrandedEmail({
      eyebrow: 'Onboarding',
      title: `Welcome to ${params.orgName}`,
      bodyHtml,
      ctaText: 'Start onboarding',
      ctaUrl: params.onboardingUrl,
      footerNote: 'You are receiving this because you were added to a team on Nugenova.',
    }),
  };
}

/** Daily nudge to a hire with outstanding onboarding items. */
/** Attendance: an employee was marked absent for a day with no record. */
export function attendanceAbsentEmail(params: {
  employeeName?: string | null;
  orgName: string;
  dateLabel: string;
  attendanceUrl: string;
}): { subject: string; html: string } {
  const greeting = params.employeeName ? `Hi ${esc(params.employeeName)},` : 'Hello,';
  const bodyHtml = `
    <p style="margin:0 0 12px;">${greeting}</p>
    <p style="margin:0 0 12px;">We didn't record any attendance for you on
      <strong style="color:#111827;">${esc(params.dateLabel)}</strong> at
      <strong style="color:#111827;">${esc(params.orgName)}</strong>, so the day was marked
      <strong style="color:#B91C1C;">absent</strong>.</p>
    <p style="margin:0 0 12px;">If you did work that day, file a manual entry for approval and it will be corrected.</p>`;
  return {
    subject: `You were marked absent for ${params.dateLabel}`,
    html: renderBrandedEmail({
      eyebrow: 'Attendance',
      title: 'Marked absent',
      bodyHtml,
      ctaText: 'Open attendance',
      ctaUrl: params.attendanceUrl,
      accent: '#DC2626',
    }),
  };
}

/** Attendance: a session was auto-closed because the employee didn't clock out. */
export function attendanceMissedCheckoutEmail(params: {
  employeeName?: string | null;
  orgName: string;
  dateLabel: string;
  hours: number;
  attendanceUrl: string;
}): { subject: string; html: string } {
  const greeting = params.employeeName ? `Hi ${esc(params.employeeName)},` : 'Hello,';
  const bodyHtml = `
    <p style="margin:0 0 12px;">${greeting}</p>
    <p style="margin:0 0 12px;">You didn't clock out on
      <strong style="color:#111827;">${esc(params.dateLabel)}</strong>, so we closed the session
      automatically and recorded <strong style="color:#111827;">${esc(params.hours)}h</strong>.</p>
    <p style="margin:0 0 12px;">If that's not right, request an edit on the record and a manager will review it.</p>`;
  return {
    subject: `We closed a session you left open on ${params.dateLabel}`,
    html: renderBrandedEmail({
      eyebrow: 'Attendance',
      title: 'Missed clock-out',
      bodyHtml,
      ctaText: 'Review the record',
      ctaUrl: params.attendanceUrl,
      accent: '#F59E0B',
    }),
  };
}

/** Attendance: a nudge to an employee who hasn't clocked in yet today. */
export function attendanceNotClockedInEmail(params: {
  employeeName?: string | null;
  orgName: string;
  attendanceUrl: string;
}): { subject: string; html: string } {
  const greeting = params.employeeName ? `Hi ${esc(params.employeeName)},` : 'Hello,';
  const bodyHtml = `
    <p style="margin:0 0 12px;">${greeting}</p>
    <p style="margin:0 0 12px;">It's past your start time and we don't have a clock-in from you today at
      <strong style="color:#111827;">${esc(params.orgName)}</strong>.</p>
    <p style="margin:0 0 12px;">If you're working, please clock in so your day is recorded.</p>`;
  return {
    subject: `Reminder: you haven't clocked in yet`,
    html: renderBrandedEmail({
      eyebrow: 'Attendance',
      title: "You haven't clocked in yet",
      bodyHtml,
      ctaText: 'Clock in',
      ctaUrl: params.attendanceUrl,
      accent: '#2E86C1',
    }),
  };
}

/** Attendance: the daily exception roll-up to org admins/approvers. */
export function attendanceDigestEmail(params: {
  orgName: string;
  dateLabel: string;
  absent: number;
  late: number;
  halfDay: number;
  missed: number;
  activityUrl: string;
}): { subject: string; html: string } {
  const row = (label: string, n: number, color: string) =>
    `<tr>
       <td style="padding:8px 0;font-size:14px;color:#4B5563;">${esc(label)}</td>
       <td style="padding:8px 0;font-size:14px;font-weight:700;color:${color};text-align:right;">${esc(n)}</td>
     </tr>`;
  const bodyHtml = `
    <p style="margin:0 0 12px;">Attendance exceptions for
      <strong style="color:#111827;">${esc(params.orgName)}</strong> on
      <strong style="color:#111827;">${esc(params.dateLabel)}</strong>:</p>
    <table cellpadding="0" cellspacing="0" width="100%" style="border-top:1px solid #F3F4F6;border-bottom:1px solid #F3F4F6;">
      ${row('Absent', params.absent, '#B91C1C')}
      ${row('Late arrivals', params.late, '#B45309')}
      ${row('Half days', params.halfDay, '#C2410C')}
      ${row('Missed checkouts', params.missed, '#6D28D9')}
    </table>`;
  return {
    subject: `Attendance summary — ${params.dateLabel}`,
    html: renderBrandedEmail({
      eyebrow: 'Attendance digest',
      title: `Yesterday's exceptions`,
      bodyHtml,
      ctaText: 'Open activity',
      ctaUrl: params.activityUrl,
      accent: '#2E86C1',
    }),
  };
}

export function onboardingReminderEmail(params: {
  employeeName?: string | null;
  orgName: string;
  pendingTitles: string[];
  onboardingUrl: string;
}): { subject: string; html: string } {
  const greeting = params.employeeName ? `Hi ${esc(params.employeeName)},` : 'Hello,';
  const bodyHtml = `
    <p style="margin:0 0 12px;">${greeting}</p>
    <p style="margin:0 0 12px;">Just a friendly reminder to finish your onboarding at
      <strong style="color:#111827;">${esc(params.orgName)}</strong>. A few items are still outstanding:</p>
    ${docListHtml(params.pendingTitles)}`;
  return {
    subject: `Reminder: ${params.pendingTitles.length} onboarding item(s) still to do`,
    html: renderBrandedEmail({
      eyebrow: 'Onboarding reminder',
      title: 'Almost there — a few items left',
      bodyHtml,
      ctaText: 'Finish onboarding',
      ctaUrl: params.onboardingUrl,
      accent: '#F59E0B',
    }),
  };
}
