/**
 * Default vertical packs — §04/§12. A vertical is a CONFIG object, not a fork:
 * the same modules, entities and guards serve every tenant; the pack only
 * changes the VOCABULARY the UI renders, WHICH modules are enabled, and the AI
 * tier CEILING the org may operate under.
 *
 * The base (`company`) pack is the platform's native HR/ops vocabulary — every
 * existing org resolves to it, unchanged. Education packs re-label the same
 * concepts (Organization→Institution, Employee→Student, Department→Grade/…) and
 * enable the education modules.
 *
 * `VerticalPackService` resolves the EFFECTIVE pack by deep-merging an org's
 * per-org `verticalPack` override on top of the orgType default below.
 */

export type OrgType = 'company' | 'school' | 'college' | 'coaching';
export const ORG_TYPES: readonly OrgType[] = [
  'company',
  'school',
  'college',
  'coaching',
];

export interface VerticalPack {
  /** UI relabelling: canonical concept key → the word this vertical uses. */
  vocabulary: Record<string, string>;
  /** Module keys enabled for this vertical (drives nav + feature gates). */
  enabledModules: string[];
  /**
   * The HIGHEST AI autonomy tier (0–3, §09) this vertical may operate at without
   * further per-learner consent. 0 = off, 1 = assistive/suggest-only, 2 =
   * drafting with human approval, 3 = autonomous actions. K-12 is capped at 1 by
   * default (minors — tiers 2–3 require recorded guardian consent); coaching
   * (adult learners) may run up to 3.
   */
  aiTierCeiling: number;
}

/** The AI tier ceiling range (§09 tiers 0–3). */
export const AI_TIER_MIN = 0;
export const AI_TIER_MAX = 3;

// The base HR/ops modules every tenant shares.
const CORE_MODULES = [
  'dashboard',
  'organization',
  'attendance',
  'leave',
  'payroll',
  'policy',
  'notification',
  'clients',
];

// The education-vertical modules that sit on the academic calendar.
const EDU_MODULES = ['academic', 'lms', 'guardian'];

export const DEFAULT_VERTICAL_PACKS: Record<OrgType, VerticalPack> = {
  // ── company (default) — the platform's native vocabulary; unchanged. ───────
  company: {
    vocabulary: {
      Organization: 'Company',
      Member: 'Employee',
      Department: 'Department',
      Leader: 'Manager',
    },
    enabledModules: [...CORE_MODULES],
    // Business tenants (adult staff) have no minor-consent constraint.
    aiTierCeiling: 3,
  },

  // ── school (K-12) — minors; AI capped at 1 unless consent lifts it. ────────
  school: {
    vocabulary: {
      Organization: 'Institution',
      Member: 'Student',
      Department: 'Grade',
      Leader: 'Class Teacher',
      Faculty: 'Faculty',
      Course: 'Subject',
      ClassSection: 'Section',
      Term: 'Term',
    },
    enabledModules: [...CORE_MODULES, ...EDU_MODULES],
    // K-12 minors: assistive only by default; tiers 2–3 need guardian consent.
    aiTierCeiling: 1,
  },

  // ── college / university — largely adult learners. ─────────────────────────
  college: {
    vocabulary: {
      Organization: 'Institution',
      Member: 'Student',
      Department: 'Faculty',
      Leader: 'Head of Department',
      Course: 'Course',
      ClassSection: 'Section',
      Term: 'Semester',
    },
    enabledModules: [...CORE_MODULES, ...EDU_MODULES],
    // Mostly adults; drafting-with-approval is acceptable by default.
    aiTierCeiling: 2,
  },

  // ── coaching / test-prep — adult learners; highest autonomy allowed. ───────
  coaching: {
    vocabulary: {
      Organization: 'Academy',
      Member: 'Student',
      Department: 'Batch',
      Leader: 'Mentor',
      Course: 'Program',
      ClassSection: 'Batch',
      Term: 'Session',
    },
    enabledModules: [...CORE_MODULES, ...EDU_MODULES],
    // Adult learners, conversion-driven: autonomous AI permitted.
    aiTierCeiling: 3,
  },
};

/** Is `t` a known org type? */
export function isOrgType(t: string): t is OrgType {
  return (ORG_TYPES as readonly string[]).includes(t);
}

/** The default pack for an orgType, falling back to `company` for anything else. */
export function defaultPackFor(orgType: string): VerticalPack {
  return DEFAULT_VERTICAL_PACKS[isOrgType(orgType) ? orgType : 'company'];
}
