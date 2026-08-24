import {
  documentsRequestedEmail,
  documentApprovedEmail,
  documentRejectedEmail,
  orgActivatedEmail,
  renderBrandedEmail,
  esc,
} from './email-layout';

/**
 * Pure unit specs for the branded email templates — no transport, no DB.
 */
describe('email-layout (unit)', () => {
  it('escapes HTML in dynamic text', () => {
    expect(esc('<script>&"')).toBe('&lt;script&gt;&amp;&quot;');
  });

  it('renders a branded shell with the CTA and copy-paste link', () => {
    const html = renderBrandedEmail({
      eyebrow: 'Onboarding',
      title: 'Hello',
      bodyHtml: '<p>Body</p>',
      ctaText: 'Go',
      ctaUrl: 'https://app.example/onboarding',
    });
    expect(html).toContain('Hello');
    expect(html).toContain('https://app.example/onboarding');
    expect(html).toContain('Go');
    // The brand blue appears as an accent somewhere in the shell.
    expect(html.toLowerCase()).toContain('#2e86c1');
  });

  it('builds a documents-requested email listing the titles + submit link', () => {
    const { subject, html } = documentsRequestedEmail({
      orgName: 'Acme',
      documentTitles: ['NDA', 'Certificate of Incorporation'],
      submitUrl: 'https://app.example/onboarding',
    });
    expect(subject).toContain('Acme');
    expect(html).toContain('NDA');
    expect(html).toContain('Certificate of Incorporation');
    expect(html).toContain('https://app.example/onboarding');
  });

  it('builds an approved email that signals when it was the last document', () => {
    const last = documentApprovedEmail({
      orgName: 'Acme',
      documentTitle: 'NDA',
      remaining: 0,
      submitUrl: 'https://app.example/onboarding',
    });
    expect(last.html.toLowerCase()).toContain('activated');
    const more = documentApprovedEmail({
      orgName: 'Acme',
      documentTitle: 'NDA',
      remaining: 2,
      submitUrl: 'https://app.example/onboarding',
    });
    expect(more.html).toContain('2 document');
  });

  it('builds a rejected email carrying the reason note', () => {
    const { html } = documentRejectedEmail({
      orgName: 'Acme',
      documentTitle: 'NDA',
      note: 'Signature illegible',
      submitUrl: 'https://app.example/onboarding',
    });
    expect(html).toContain('Signature illegible');
  });

  it('builds an activation welcome email with a login link', () => {
    const { subject, html } = orgActivatedEmail({
      orgName: 'Acme',
      loginUrl: 'https://app.example/login',
    });
    expect(subject).toContain('Acme');
    expect(html).toContain('https://app.example/login');
  });
});
