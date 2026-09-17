/**
 * The 5xx error-alert email, with no service dependencies so both the reporter
 * and the email catalog's preview can import it without a module cycle.
 */

/** Everything known about one failed request. */
export interface ReportedError {
  /** Short id shown to the caller, logged, and put in the email subject. */
  reference: string;
  status: number;
  method: string;
  path: string;
  message: string;
  /** Present for a real exception; absent when a non-Error was thrown. */
  stack?: string;
  organizationId?: string | null;
  userId?: string | null;
  userEmail?: string | null;
  ip?: string | null;
  at: Date;
}

/**
 * The 5xx alert email. Exported so the Roles page preview renders exactly what
 * recipients get.
 */
export function renderErrorAlertEmail(err: ReportedError): { subject: string; html: string } {
  const subject = `[Nugenova] ${err.status} on ${err.method} ${err.path} (${err.reference})`;

  const rows: [string, string][] = [
    ['Reference', err.reference],
    ['When', err.at.toISOString()],
    ['Status', String(err.status)],
    ['Request', `${err.method} ${err.path}`],
    ['Organization', err.organizationId ?? '—'],
    ['User', err.userEmail || err.userId || 'not signed in'],
    ['IP', err.ip ?? '—'],
  ];
  const table = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#64748B">${k}</td><td style="padding:4px 0;color:#0F172A"><b>${esc(v)}</b></td></tr>`,
    )
    .join('');
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#0F172A">
      <h2 style="margin:0 0 4px">A request failed with a ${err.status}</h2>
      <p style="margin:0 0 16px;color:#64748B">This is the complete reason, as recorded in the activity log.</p>
      <table style="border-collapse:collapse;font-size:13px">${table}</table>
      <h3 style="margin:20px 0 4px;font-size:14px">Message</h3>
      <pre style="white-space:pre-wrap;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:12px;font-size:12px">${esc(err.message)}</pre>
      ${
        err.stack
          ? `<h3 style="margin:20px 0 4px;font-size:14px">Stack</h3>
      <pre style="white-space:pre-wrap;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:12px;font-size:11.5px;color:#334155">${esc(err.stack)}</pre>`
          : ''
      }
      <p style="margin:20px 0 0;font-size:12px;color:#94A3B8">
        Further alerts about this same request are held back for a few minutes so a repeating fault doesn't flood your inbox.
      </p>
    </div>`;
  return { subject, html };
}

/** The stack and message are untrusted text — never interpolate them raw. */
function esc(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
