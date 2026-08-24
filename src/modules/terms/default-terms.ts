/**
 * The default platform Terms & Conditions, seeded as version 1 on first boot.
 * The super admin can edit it via `PUT /admin/terms`; each edit bumps the
 * version and forces every organization to re-accept.
 */
export const DEFAULT_TERMS_HTML = `
<h2>Nugenova Platform — Terms &amp; Conditions</h2>
<p>By accepting these terms, your organization agrees to the following in order to
use the Nugenova platform.</p>

<h3>1. Acceptable use</h3>
<p>You will use the platform only for lawful business purposes and will not misuse,
disrupt, or attempt to gain unauthorized access to the service or other tenants'
data.</p>

<h3>2. Accounts &amp; access</h3>
<p>You are responsible for the accounts you create within your organization, for
keeping access credentials secure, and for the activity that occurs under them.</p>

<h3>3. Data</h3>
<p>You retain ownership of the data your organization submits. Nugenova processes it
solely to provide the service, applies industry-standard security measures, and
does not sell your data.</p>

<h3>4. Compliance documents</h3>
<p>Nugenova may request verification or compliance documents from time to time. You
agree to provide accurate documents on request. Failure to fulfil a required
condition may result in your organization being suspended.</p>

<h3>5. Availability &amp; changes</h3>
<p>The service is provided on a commercially reasonable best-effort basis. These
terms may be updated; when they change you will be asked to review and accept the
updated version before continuing to use the platform.</p>

<h3>6. Termination</h3>
<p>Either party may terminate use in accordance with the applicable agreement.
Nugenova may suspend access where these terms are breached or a required condition
is not met.</p>

<p>By clicking “I accept”, the authorized representative confirms they are empowered
to bind the organization to these Terms &amp; Conditions.</p>
`.trim();
