/** Shared enums for the Sales & Leads module (Phase 1). */

/** `client` = the lead came from an existing client (see `leads.sourceClientId`). */
export const LEAD_SOURCES = ['website', 'referral', 'client', 'campaign', 'cold_call', 'event', 'social', 'import', 'other'] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

/**
 * Per-source detail fields captured on a lead (`leads.sourceMeta`), e.g. who referred
 * it or which event it came from. Unknown keys are dropped on save. `client` uses
 * `sourceClientId`; `other` uses the free-text `sourceDetail`.
 */
export const LEAD_SOURCE_FIELDS: Record<LeadSource, readonly string[]> = {
  website: ['page', 'utm'],
  referral: ['referrerName', 'referrerContact'],
  client: [],
  campaign: ['campaignName', 'channel'],
  cold_call: ['calledBy', 'callDate'],
  event: ['eventName', 'eventDate', 'eventLocation'],
  social: ['platform', 'profileUrl'],
  import: [],
  other: [],
};

export const LEAD_STATUSES = ['open', 'won', 'lost', 'on_hold'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** Timeline (activities + follow-ups) can hang off any of these. */
export const SALES_ENTITY_TYPES = ['lead', 'deal', 'account', 'contact'] as const;
export type SalesEntityType = (typeof SALES_ENTITY_TYPES)[number];

export const ACTIVITY_TYPES = ['note', 'call', 'email', 'meeting', 'whatsapp', 'visit', 'other', 'stage_change', 'system'] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const FOLLOWUP_STATUSES = ['pending', 'done', 'snoozed'] as const;
export type FollowupStatus = (typeof FOLLOWUP_STATUSES)[number];

/** Whose court the ball is in for a follow-up (e.g. we sent a proposal → waiting on the client). */
export const FOLLOWUP_WAITING_ON = ['client', 'us'] as const;
export type FollowupWaitingOn = (typeof FOLLOWUP_WAITING_ON)[number];

/** Conventional B2B funnel seeded per org on first use. Probability feeds the weighted forecast. */
export const DEFAULT_STAGES: { name: string; order: number; isWon: boolean; isLost: boolean; probability: number; color: string; isDefault: boolean }[] = [
  { name: 'New', order: 1, isWon: false, isLost: false, probability: 10, color: '#94A3B8', isDefault: true },
  { name: 'Contacted', order: 2, isWon: false, isLost: false, probability: 25, color: '#38BDF8', isDefault: false },
  { name: 'Qualified', order: 3, isWon: false, isLost: false, probability: 40, color: '#6366F1', isDefault: false },
  { name: 'Proposal', order: 4, isWon: false, isLost: false, probability: 60, color: '#A855F7', isDefault: false },
  { name: 'Negotiation', order: 5, isWon: false, isLost: false, probability: 80, color: '#F59E0B', isDefault: false },
  { name: 'Won', order: 6, isWon: true, isLost: false, probability: 100, color: '#22C55E', isDefault: false },
  { name: 'Lost', order: 7, isWon: false, isLost: true, probability: 0, color: '#EF4444', isDefault: false },
];
