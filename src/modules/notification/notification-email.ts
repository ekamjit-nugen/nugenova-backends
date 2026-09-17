import { notificationEmail } from '../../bootstrap/mail/email-layout';
import { emailMetaForType } from './notification-catalog';

/** Per-notification email control: force-off, force-on, or override the copy. */
export type EmailOption =
  | boolean
  | {
      eyebrow?: string;
      cta?: string;
      subject?: string;
      bodyHtml?: string;
      footerNote?: string;
    };

/**
 * Build the branded email for a notification — the ONE function both the real
 * send (NotifierService.maybeEmail) and the Roles page preview call, so a preview
 * can never drift from what recipients actually get. Returns null when the type
 * isn't email-worthy and no override was given.
 */
export function renderNotificationEmail(input: {
  type: string;
  title: string;
  body?: string | null;
  actionUrl?: string;
  email?: EmailOption;
  /** Turns a relative app path into the absolute link used in the email. */
  absoluteUrl: (path: string) => string;
}): { subject: string; html: string } | null {
  const override = typeof input.email === 'object' ? input.email : null;
  const meta = override
    ? { eyebrow: override.eyebrow ?? 'Notification', cta: override.cta, footerNote: override.footerNote }
    : emailMetaForType(input.type);
  if (!meta) return null;
  const ctaText = override?.cta ?? meta.cta;
  const ctaUrl = ctaText && input.actionUrl ? input.absoluteUrl(input.actionUrl) : undefined;
  return notificationEmail({
    eyebrow: override?.eyebrow ?? meta.eyebrow,
    title: override?.subject ?? input.title,
    body: input.body,
    bodyHtml: override?.bodyHtml,
    ctaText: ctaUrl ? ctaText : undefined,
    ctaUrl,
    footerNote: override?.footerNote ?? meta.footerNote,
  });
}
