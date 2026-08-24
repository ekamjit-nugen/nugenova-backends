import { DEFAULT_TERMS_HTML } from './default-terms';

/**
 * A ready-made Terms & Conditions template the super admin can pick as a
 * starting point in the editor. Picking one loads its HTML into the editor; the
 * super admin can then tweak and publish, or upload a PDF instead.
 */
export interface TermsTemplate {
  id: string;
  name: string;
  description: string;
  html: string;
}

const STARTUP_HTML = `
<h2>Nugenova Platform — Terms of Service</h2>
<p>Welcome. By accepting these terms your organization agrees to the essentials
below so you can get started quickly.</p>

<h3>1. Using the service</h3>
<p>Use the platform for lawful business purposes. Don't abuse it, resell it, or
try to access other organizations' data.</p>

<h3>2. Your account</h3>
<p>You're responsible for the people you invite and for keeping their access
secure. Activity under your organization is your responsibility.</p>

<h3>3. Your data</h3>
<p>Your data stays yours. We process it only to run the service, keep it secure,
and never sell it.</p>

<h3>4. Fair use &amp; changes</h3>
<p>We provide the service on a best-effort basis and may update these terms. When
they change, you'll be asked to review and accept the new version before
continuing.</p>

<p>By clicking &ldquo;I accept&rdquo;, you confirm you're authorized to accept
these terms for your organization.</p>
`.trim();

const ENTERPRISE_HTML = `
<h2>Nugenova Platform — Master Terms &amp; Conditions (Enterprise)</h2>
<p>These Master Terms govern your organization's access to and use of the
Nugenova platform and any associated services.</p>

<h3>1. Definitions &amp; scope</h3>
<p>&ldquo;Service&rdquo; means the Nugenova platform. &ldquo;Customer Data&rdquo;
means data your organization submits. These terms apply to all users provisioned
under your organization.</p>

<h3>2. Acceptable use</h3>
<p>You will use the Service only for lawful business purposes, will not attempt to
gain unauthorized access, reverse-engineer, or disrupt the Service, and will not
exceed agreed usage limits.</p>

<h3>3. Accounts, roles &amp; security</h3>
<p>You are responsible for administering roles and access within your
organization, for safeguarding credentials, and for all activity under your
accounts. You will notify us promptly of any suspected compromise.</p>

<h3>4. Data protection</h3>
<p>You retain ownership of Customer Data. We process it solely to provide the
Service, apply industry-standard technical and organizational security measures,
support your data-subject and audit obligations, and do not sell Customer Data.</p>

<h3>5. Compliance &amp; verification</h3>
<p>We may request verification or compliance documents from time to time. You
agree to provide accurate documents on request. Failure to fulfil a required
condition may result in suspension.</p>

<h3>6. Availability &amp; support</h3>
<p>The Service is provided on a commercially reasonable best-effort basis, subject
to any separately agreed service levels. Planned maintenance will be communicated
where practicable.</p>

<h3>7. Term, suspension &amp; termination</h3>
<p>Either party may terminate in accordance with the applicable order or
agreement. We may suspend access where these terms are breached or a required
condition is not met.</p>

<h3>8. Changes</h3>
<p>These terms may be updated; when they change your organization will be asked to
review and accept the updated version before continuing to use the Service.</p>

<p>By clicking &ldquo;I accept&rdquo;, the authorized representative confirms they
are empowered to bind the organization to these Terms &amp; Conditions.</p>
`.trim();

const DATA_PROCESSING_HTML = `
<h2>Nugenova Platform — Terms &amp; Data Processing Addendum</h2>
<p>These terms include data-processing commitments for organizations with privacy
and regulatory obligations.</p>

<h3>1. Acceptable use</h3>
<p>Use the platform only for lawful business purposes and do not misuse, disrupt,
or attempt unauthorized access to the Service or other tenants' data.</p>

<h3>2. Roles of the parties</h3>
<p>For personal data your organization submits, your organization acts as the
data controller and Nugenova acts as a data processor, processing such data only
on your documented instructions to provide the Service.</p>

<h3>3. Security measures</h3>
<p>Nugenova maintains appropriate technical and organizational measures —
including access control, encryption in transit, tenant isolation, and audit
logging — designed to protect personal data against unauthorized access, loss, or
disclosure.</p>

<h3>4. Sub-processors</h3>
<p>Nugenova may engage sub-processors (such as cloud infrastructure providers) to
deliver the Service, and remains responsible for their compliance with these
commitments.</p>

<h3>5. Data-subject rights &amp; assistance</h3>
<p>Nugenova will provide reasonable assistance to help you respond to data-subject
requests and to meet your security, breach-notification, and audit obligations.</p>

<h3>6. Retention &amp; deletion</h3>
<p>On termination, Nugenova will delete or return Customer Data in accordance with
the applicable agreement and legal retention requirements.</p>

<h3>7. Compliance documents &amp; changes</h3>
<p>Nugenova may request verification documents; you agree to provide accurate
documents on request. These terms may be updated, and you will be asked to review
and accept the updated version before continuing.</p>

<p>By clicking &ldquo;I accept&rdquo;, the authorized representative confirms they
are empowered to bind the organization to these Terms &amp; the Data Processing
Addendum.</p>
`.trim();

/**
 * The template catalog offered in the super-admin terms editor. `standard` is
 * also what seeds version 1 on first boot (see TermsService).
 */
export const TERMS_TEMPLATES: TermsTemplate[] = [
  {
    id: 'standard',
    name: 'Standard SaaS',
    description:
      'Balanced, general-purpose terms covering acceptable use, accounts, data, and compliance.',
    html: DEFAULT_TERMS_HTML,
  },
  {
    id: 'startup',
    name: 'Startup / Lightweight',
    description:
      'A short, plain-language agreement for quick onboarding of smaller organizations.',
    html: STARTUP_HTML,
  },
  {
    id: 'enterprise',
    name: 'Enterprise / Compliance',
    description:
      'Detailed master terms with security, verification, suspension, and change controls.',
    html: ENTERPRISE_HTML,
  },
  {
    id: 'data-processing',
    name: 'Privacy / Data Processing',
    description:
      'Adds controller–processor roles, sub-processors, and data-subject-rights commitments.',
    html: DATA_PROCESSING_HTML,
  },
];

export const DEFAULT_TERMS_TEMPLATE_ID = 'standard';
