/**
 * The built-in onboarding document library — the documents a super admin can
 * REQUEST an organization to upload (KYC / statutory scans like PAN, GST, the
 * certificate of incorporation, etc.). Seeded idempotently at startup
 * (DocumentTemplateService.seedBuiltins), keyed by `key`, so re-runs update in
 * place and never duplicate.
 *
 * These are all UPLOAD documents: the org attaches a photo/scan/PDF and the super
 * admin reviews it. Agreements are NOT in this library — an agreement is a PDF
 * the super admin uploads and places fields on (signature / first name / last
 * name / date …) for the org to sign in place; that path does not use templates.
 */
export interface BuiltinTemplate {
  key: string;
  name: string;
  description: string;
  category: string;
  bodyHtml: string;
  requiresSignature: boolean;
  requiresUpload: boolean;
  fields: null;
}

const p = (text: string) =>
  `<p style="margin:0 0 12px;line-height:1.6;">${text}</p>`;

const uploadDoc = (
  key: string,
  name: string,
  category: string,
  description: string,
  instructions: string,
): BuiltinTemplate => ({
  key,
  name,
  category,
  description,
  requiresSignature: false,
  requiresUpload: true,
  fields: null,
  bodyHtml: `<h3 style="margin:0 0 12px;">${name}</h3>${p(instructions)}${p(
    'Accepted formats: PDF, JPG, or PNG (max 25 MB). Make sure the details are clearly legible.',
  )}`,
});

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  uploadDoc(
    'builtin_incorporation_certificate',
    'Certificate of Incorporation',
    'registration',
    'Your official certificate of incorporation / company registration.',
    "Please upload a clear scan or PDF of your organization's official Certificate of Incorporation (or equivalent company registration document). It must clearly show the registered entity name and registration number.",
  ),
  uploadDoc(
    'builtin_gst_certificate',
    'GST / Tax Registration Certificate',
    'tax',
    'Your GST (or local tax) registration certificate.',
    'Please upload your GST registration certificate (or the equivalent tax registration document for your jurisdiction). The GSTIN / tax identification number must be clearly visible.',
  ),
  uploadDoc(
    'builtin_pan_card',
    'Company PAN Card',
    'tax',
    'Your company PAN card (or national tax ID).',
    "Please upload a photo or scan of your organization's PAN card (or the equivalent national tax identification document).",
  ),
  uploadDoc(
    'builtin_bank_details',
    'Bank Account Details',
    'bank',
    'A cancelled cheque or bank letter confirming your account.',
    "Please upload a cancelled cheque or an official bank letter confirming your organization's account name, account number, and IFSC / SWIFT code. This is used to set up billing.",
  ),
  uploadDoc(
    'builtin_address_proof',
    'Registered Address Proof',
    'kyc',
    'Proof of your registered business address.',
    'Please upload a recent utility bill, lease agreement, or municipal document showing your organization at its registered address (dated within the last 3 months where applicable).',
  ),
  uploadDoc(
    'builtin_board_resolution',
    'Board Resolution',
    'kyc',
    'A board resolution authorizing this onboarding.',
    'Please upload the signed board resolution authorizing your organization to onboard to and transact on the platform, naming the authorized signatory.',
  ),
  uploadDoc(
    'builtin_signatory_id',
    'Authorized Signatory ID Proof',
    'kyc',
    "Government ID of the person authorized to sign on the organization's behalf.",
    "Please upload a government-issued photo ID (passport, driver's licence, or national ID) of the authorized signatory.",
  ),
];
