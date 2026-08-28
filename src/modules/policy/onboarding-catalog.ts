/**
 * The onboarding-requirements catalog — the master list of documents an org MAY
 * ask a new hire to submit, plus the default checklist and probation/target
 * defaults. An org's actual requirements are a SELECTION over this catalog,
 * stored as the org's `onboarding` policy config (see PolicyService).
 *
 * Ported from the monolith's `onboarding-catalog.ts` (grouped Identity/Financial/
 * Education/Experience/Compliance/Personal), Nexora-shaped: keys are stable
 * slugs the lifecycle records reference, so a policy edit reconciles cleanly onto
 * in-progress onboardings by key.
 */

export interface OnboardingDocumentCatalogItem {
  key: string;
  title: string;
  group: OnboardingDocumentGroup;
  /** Whether this doc is required by default when first added to a config. */
  defaultRequired?: boolean;
}

export type OnboardingDocumentGroup =
  | 'Identity'
  | 'Financial'
  | 'Education'
  | 'Experience'
  | 'Compliance'
  | 'Personal';

/** A single configured document requirement on an org's onboarding policy. */
export interface OnboardingConfigDocument {
  key: string;
  title: string;
  required: boolean;
}

/** A single configured checklist task. `assignedTo` decides who can complete it. */
export interface OnboardingConfigChecklistItem {
  key: string;
  title: string;
  category: OnboardingChecklistCategory;
  /** self = the hire completes it; hr / it = a privileged member does. */
  assignedTo: 'self' | 'hr' | 'it';
}

export type OnboardingChecklistCategory =
  | 'documents'
  | 'welcome'
  | 'training'
  | 'it_setup'
  | 'compliance'
  | 'other';

/** The org's onboarding requirements — what every new hire must submit/complete. */
export interface OnboardingConfig {
  documents: OnboardingConfigDocument[];
  checklist: OnboardingConfigChecklistItem[];
  defaultProbationMonths: number;
  targetDays: number;
  /**
   * Which profile fields a new hire must fill for the "Complete your profile"
   * checklist task to auto-complete. Owner-configurable; keys from
   * PROFILE_FIELD_CATALOG. Name is always implicitly required.
   */
  profileFields: string[];
}

export interface ProfileFieldCatalogItem {
  key: string;
  label: string;
}

/**
 * The profile fields the owner can require for onboarding "profile complete".
 * (First/last name are the display identity and are always required, so they're
 * not listed as optional toggles.)
 */
export const PROFILE_FIELD_CATALOG: ProfileFieldCatalogItem[] = [
  { key: 'jobTitle', label: 'Job title' },
  { key: 'phoneNumber', label: 'Phone number' },
  { key: 'department', label: 'Department' },
  { key: 'location', label: 'Location' },
  { key: 'timezone', label: 'Timezone' },
  { key: 'bio', label: 'Bio' },
  { key: 'avatar', label: 'Profile photo' },
  { key: 'linkedIn', label: 'LinkedIn' },
  { key: 'github', label: 'GitHub' },
];

const PROFILE_FIELD_KEYS = new Set(PROFILE_FIELD_CATALOG.map((f) => f.key));

/** Keep only recognised profile-field keys (guards stored/DTO data). */
export function sanitizeProfileFields(keys: unknown): string[] {
  if (!Array.isArray(keys)) return [];
  return [...new Set(keys.filter((k): k is string => typeof k === 'string' && PROFILE_FIELD_KEYS.has(k)))];
}

export const DEFAULT_REQUIRED_PROFILE_FIELDS = ['jobTitle', 'phoneNumber'];

/**
 * The full document catalog. `defaultRequired` items make up the seeded default
 * config so an org that never opens Settings still onboards sensibly.
 */
export const ONBOARDING_DOCUMENT_CATALOG: OnboardingDocumentCatalogItem[] = [
  // Identity
  { key: 'photo_id', title: 'Government Photo ID', group: 'Identity', defaultRequired: true },
  { key: 'passport', title: 'Passport', group: 'Identity' },
  { key: 'address_proof', title: 'Proof of Address', group: 'Identity', defaultRequired: true },
  // Financial
  { key: 'pan_card', title: 'PAN Card', group: 'Financial', defaultRequired: true },
  { key: 'bank_details', title: 'Bank Account Details', group: 'Financial', defaultRequired: true },
  { key: 'cancelled_cheque', title: 'Cancelled Cheque', group: 'Financial' },
  // Education
  { key: 'degree_certificate', title: 'Degree Certificate', group: 'Education' },
  { key: 'marksheets', title: 'Academic Marksheets', group: 'Education' },
  // Experience
  { key: 'experience_letter', title: 'Previous Experience Letter', group: 'Experience' },
  { key: 'relieving_letter', title: 'Relieving Letter', group: 'Experience' },
  { key: 'last_payslips', title: 'Last 3 Payslips', group: 'Experience' },
  // Compliance
  { key: 'signed_offer', title: 'Signed Offer Letter', group: 'Compliance', defaultRequired: true },
  { key: 'nda', title: 'Signed NDA', group: 'Compliance' },
  { key: 'background_consent', title: 'Background Check Consent', group: 'Compliance' },
  // Personal
  { key: 'photo', title: 'Passport-size Photograph', group: 'Personal' },
  { key: 'emergency_contact', title: 'Emergency Contact Form', group: 'Personal' },
];

/** The default checklist seeded for a new org's onboarding config. */
export const DEFAULT_ONBOARDING_CHECKLIST: OnboardingConfigChecklistItem[] = [
  { key: 'welcome_read', title: 'Read the welcome guide', category: 'welcome', assignedTo: 'self' },
  { key: 'profile_complete', title: 'Complete your profile', category: 'welcome', assignedTo: 'self' },
  { key: 'policies_ack', title: 'Acknowledge company policies', category: 'compliance', assignedTo: 'self' },
  { key: 'it_accounts', title: 'Provision IT accounts & email', category: 'it_setup', assignedTo: 'it' },
  { key: 'workstation', title: 'Set up workstation / access', category: 'it_setup', assignedTo: 'it' },
  { key: 'intro_meeting', title: 'Schedule team introduction', category: 'welcome', assignedTo: 'hr' },
];

export const DEFAULT_PROBATION_MONTHS = 6;
export const DEFAULT_ONBOARDING_TARGET_DAYS = 14;

/** Checklist categories a hire is allowed to self-complete on My Onboarding. */
export const SELF_SERVICE_CHECKLIST_CATEGORIES: OnboardingChecklistCategory[] = [
  'documents',
  'welcome',
  'training',
];

/** The seeded default config: every catalog doc flagged `defaultRequired`. */
export function defaultOnboardingConfig(): OnboardingConfig {
  return {
    documents: ONBOARDING_DOCUMENT_CATALOG.filter((d) => d.defaultRequired).map((d) => ({
      key: d.key,
      title: d.title,
      required: true,
    })),
    checklist: DEFAULT_ONBOARDING_CHECKLIST.map((c) => ({ ...c })),
    defaultProbationMonths: DEFAULT_PROBATION_MONTHS,
    targetDays: DEFAULT_ONBOARDING_TARGET_DAYS,
    profileFields: [...DEFAULT_REQUIRED_PROFILE_FIELDS],
  };
}

/** The catalog grouped for the Settings UI. */
export function catalogByGroup(): { group: OnboardingDocumentGroup; items: OnboardingDocumentCatalogItem[] }[] {
  const groups: OnboardingDocumentGroup[] = [
    'Identity',
    'Financial',
    'Education',
    'Experience',
    'Compliance',
    'Personal',
  ];
  return groups.map((group) => ({
    group,
    items: ONBOARDING_DOCUMENT_CATALOG.filter((d) => d.group === group),
  }));
}
