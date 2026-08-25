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
}

/**
 * The one shared shell. `bodyHtml` is inserted verbatim (callers assemble it from
 * esc()'d fragments); everything else is escaped here.
 */
export function renderBrandedEmail(opts: BrandedEmailOptions): string {
  const accent = opts.accent || BRAND_BLUE;
  const year = opts.year || 2026;
  const cta =
    opts.ctaText && opts.ctaUrl
      ? `
            <table cellpadding="0" cellspacing="0" width="100%" style="margin-top:28px;"><tr><td align="center">
              <a href="${opts.ctaUrl}" style="display:inline-block;background:${accent};color:#FFFFFF;font-size:15px;font-weight:600;text-decoration:none;padding:12px 32px;border-radius:8px;">${esc(
                opts.ctaText,
              )}</a>
            </td></tr></table>
            <p style="margin:24px 0 0;font-size:13px;line-height:1.5;color:#9CA3AF;">
              If the button doesn't work, copy and paste this link into your browser:<br/>
              <a href="${opts.ctaUrl}" style="color:${accent};word-break:break-all;">${opts.ctaUrl}</a>
            </p>`
      : '';
  const footerNote = opts.footerNote
    ? `<p style="margin:0 0 6px;font-size:12px;color:#9CA3AF;">${esc(opts.footerNote)}</p>`
    : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F3F4F6;font-family:'Inter',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;padding:40px 0;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
        <tr>
          <td style="background:${accent};padding:24px 40px;">
            <div style="color:rgba(255,255,255,0.82);font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">${esc(
              opts.eyebrow,
            )}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 40px 8px;">
            <h1 style="margin:0 0 12px;font-size:21px;font-weight:600;color:#111827;">${esc(
              opts.title,
            )}</h1>
            <div style="margin:0;font-size:15px;line-height:1.6;color:#4B5563;">${opts.bodyHtml}</div>${cta}
          </td>
        </tr>
        <tr>
          <td style="padding:22px 40px 28px;border-top:1px solid #F3F4F6;text-align:center;">
            ${footerNote}
            <p style="margin:0;font-size:12px;color:#9CA3AF;">&copy; ${year} Nugenova. This is an automated message.</p>
          </td>
        </tr>
      </table>
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
