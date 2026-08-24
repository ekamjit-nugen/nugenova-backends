import { DocumentField } from './entities/onboarding-document-template.entity';

/**
 * The built-in onboarding document library. Seeded idempotently at startup
 * (DocumentTemplateService.seedBuiltins) keyed by `key`, so re-runs update in
 * place and never duplicate.
 *
 * Two shapes:
 *  - agreements (`requiresSignature`) — carry `bodyHtml` (the contract text) and a
 *    signature-field layout the org signs in-browser;
 *  - certificates / KYC (`requiresUpload`) — carry instructions and expect a file.
 *
 * Field positions are page-relative percentages (same convention as the
 * monolith), placed near the foot of page 0.
 */
export interface BuiltinTemplate {
  key: string;
  name: string;
  description: string;
  category: string;
  bodyHtml: string;
  requiresSignature: boolean;
  requiresUpload: boolean;
  fields: DocumentField[] | null;
}

const signatureBlock = (label = 'Authorized signatory'): DocumentField[] => [
  {
    key: 'name',
    type: 'name',
    page: 0,
    xPct: 8,
    yPct: 78,
    wPct: 40,
    hPct: 5,
    required: true,
    label: 'Full name',
  },
  {
    key: 'signature',
    type: 'signature',
    page: 0,
    xPct: 8,
    yPct: 84,
    wPct: 34,
    hPct: 9,
    required: true,
    label,
  },
  {
    key: 'date',
    type: 'date',
    page: 0,
    xPct: 60,
    yPct: 84,
    wPct: 30,
    hPct: 5,
    required: true,
    label: 'Date',
  },
];

const p = (text: string) =>
  `<p style="margin:0 0 12px;line-height:1.6;">${text}</p>`;

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    key: 'builtin_nda',
    name: 'Mutual Non-Disclosure Agreement',
    description:
      'Protects confidential information exchanged between your organization and Nugenova.',
    category: 'nda',
    requiresSignature: true,
    requiresUpload: false,
    fields: signatureBlock('Authorized signatory'),
    bodyHtml: [
      `<h3 style="margin:0 0 12px;">Mutual Non-Disclosure Agreement</h3>`,
      p(
        `This Agreement is entered into between your organization ("Disclosing Party") and Nugenova ("Receiving Party") to protect confidential information shared during the onboarding and ongoing use of the platform.`,
      ),
      p(
        `<strong>1. Confidential Information.</strong> Each party may disclose business, technical, financial, and operational information that is marked or reasonably understood to be confidential.`,
      ),
      p(
        `<strong>2. Obligations.</strong> The Receiving Party shall use Confidential Information solely to perform the onboarding and service, and shall not disclose it to third parties without prior written consent.`,
      ),
      p(
        `<strong>3. Term.</strong> Confidentiality obligations survive for three (3) years from the date of disclosure.`,
      ),
      p(
        `By signing below, the authorized signatory confirms they are empowered to bind the organization to this Agreement.`,
      ),
    ].join(''),
  },
  {
    key: 'builtin_msa',
    name: 'Master Services Agreement',
    description:
      'The governing commercial terms between your organization and Nugenova.',
    category: 'msa',
    requiresSignature: true,
    requiresUpload: false,
    fields: signatureBlock('Authorized signatory'),
    bodyHtml: [
      `<h3 style="margin:0 0 12px;">Master Services Agreement</h3>`,
      p(
        `This Master Services Agreement ("MSA") sets out the framework under which Nugenova provides its platform and services to your organization.`,
      ),
      p(
        `<strong>1. Services.</strong> Nugenova provides access to its HR, payroll, and collaboration platform as described in the applicable order or subscription.`,
      ),
      p(
        `<strong>2. Fees.</strong> Fees are billed per the selected subscription plan. Taxes are additional where applicable.`,
      ),
      p(
        `<strong>3. Data & Security.</strong> Nugenova maintains industry-standard security controls and processes personal data per the Data Processing Agreement.`,
      ),
      p(
        `<strong>4. Termination.</strong> Either party may terminate for material breach on thirty (30) days' written notice if uncured.`,
      ),
    ].join(''),
  },
  {
    key: 'builtin_dpa',
    name: 'Data Processing Agreement',
    description:
      'Governs how personal data is processed, as required for privacy compliance.',
    category: 'agreement',
    requiresSignature: true,
    requiresUpload: false,
    fields: signatureBlock('Data controller representative'),
    bodyHtml: [
      `<h3 style="margin:0 0 12px;">Data Processing Agreement</h3>`,
      p(
        `This Data Processing Agreement ("DPA") forms part of the MSA and governs Nugenova's processing of personal data on behalf of your organization (the "Controller").`,
      ),
      p(
        `<strong>1. Scope.</strong> Nugenova processes employee and organizational data solely to provide the platform and on the Controller's documented instructions.`,
      ),
      p(
        `<strong>2. Security.</strong> Appropriate technical and organizational measures are maintained to protect personal data.`,
      ),
      p(
        `<strong>3. Sub-processors.</strong> The Controller authorizes the use of vetted sub-processors under equivalent obligations.`,
      ),
      p(
        `<strong>4. Data Subject Rights.</strong> Nugenova assists the Controller in responding to data subject requests.`,
      ),
    ].join(''),
  },
  {
    key: 'builtin_authorized_signatory',
    name: 'Authorized Signatory Declaration',
    description:
      'Confirms who is authorized to act and sign on behalf of your organization.',
    category: 'kyc',
    requiresSignature: true,
    requiresUpload: false,
    fields: signatureBlock('Authorized signatory'),
    bodyHtml: [
      `<h3 style="margin:0 0 12px;">Authorized Signatory Declaration</h3>`,
      p(
        `I declare that I am duly authorized to represent and bind my organization for the purposes of onboarding to and using the Nugenova platform.`,
      ),
      p(
        `I confirm that the information provided during onboarding is true and accurate to the best of my knowledge.`,
      ),
    ].join(''),
  },
  {
    key: 'builtin_incorporation_certificate',
    name: 'Certificate of Incorporation',
    description:
      'Upload your official certificate of incorporation / company registration.',
    category: 'certificate',
    requiresSignature: false,
    requiresUpload: true,
    fields: null,
    bodyHtml: [
      `<h3 style="margin:0 0 12px;">Certificate of Incorporation</h3>`,
      p(
        `Please upload a clear scan or PDF of your organization's official Certificate of Incorporation (or equivalent company registration document).`,
      ),
      p(
        `Accepted formats: PDF, JPG, or PNG. The document must clearly show the registered entity name and registration number.`,
      ),
    ].join(''),
  },
  {
    key: 'builtin_gst_certificate',
    name: 'GST / Tax Registration Certificate',
    description: 'Upload your GST (or local tax) registration certificate.',
    category: 'tax',
    requiresSignature: false,
    requiresUpload: true,
    fields: null,
    bodyHtml: [
      `<h3 style="margin:0 0 12px;">GST / Tax Registration Certificate</h3>`,
      p(
        `Please upload your organization's GST registration certificate (or the equivalent tax registration document for your jurisdiction).`,
      ),
      p(`The GSTIN / tax identification number must be clearly visible.`),
    ].join(''),
  },
  {
    key: 'builtin_pan_card',
    name: 'Company PAN Card',
    description: 'Upload your company PAN card (or national tax ID).',
    category: 'tax',
    requiresSignature: false,
    requiresUpload: true,
    fields: null,
    bodyHtml: [
      `<h3 style="margin:0 0 12px;">Company PAN Card</h3>`,
      p(
        `Please upload a scan of your organization's PAN card (or the equivalent national tax identification document).`,
      ),
    ].join(''),
  },
  {
    key: 'builtin_bank_details',
    name: 'Bank Account Details',
    description:
      'Provide a cancelled cheque or bank letter confirming your account for billing.',
    category: 'bank',
    requiresSignature: false,
    requiresUpload: true,
    fields: null,
    bodyHtml: [
      `<h3 style="margin:0 0 12px;">Bank Account Details</h3>`,
      p(
        `Please upload a cancelled cheque or an official bank letter confirming your organization's account name, account number, and IFSC / SWIFT code. This is used to set up billing.`,
      ),
    ].join(''),
  },
];
