/** Shared enums for the Recruitment (ATS) module. */

/** Permission resource key (roles matrix). */
export const RECRUITMENT_RESOURCE = 'recruitment';

export const CANDIDATE_SOURCES = [
  'cutshort', 'linkedin', 'naukri', 'indeed', 'referral', 'careers_page', 'agency', 'walk_in', 'import', 'other',
] as const;
export type CandidateSource = (typeof CANDIDATE_SOURCES)[number];

export const CANDIDATE_STATUSES = ['active', 'on_hold', 'blacklisted', 'archived'] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

export const NOTICE_STATUSES = ['immediate', 'serving', 'negotiable', 'fixed', 'unknown'] as const;
export type NoticeStatus = (typeof NOTICE_STATUSES)[number];

export const OPENING_STATUSES = ['draft', 'open', 'on_hold', 'closed', 'filled'] as const;
export type OpeningStatus = (typeof OPENING_STATUSES)[number];

export const WORK_MODES = ['onsite', 'hybrid', 'remote'] as const;
export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'internship', 'freelance'] as const;
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

export const STAGE_KINDS = ['active', 'hired', 'rejected'] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

export const APPLICATION_STATUSES = ['active', 'hired', 'rejected', 'withdrawn'] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const DOCUMENT_KINDS = ['resume', 'cover_letter', 'offer_letter', 'id_proof', 'other'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const PARSE_STATUSES = ['pending', 'parsed', 'partial', 'failed', 'no_text'] as const;
export type ParseStatus = (typeof PARSE_STATUSES)[number];

export const INTERVIEW_TYPES = ['phone', 'video', 'technical', 'hr', 'onsite', 'assignment'] as const;
export const INTERVIEW_STATUSES = ['scheduled', 'completed', 'cancelled', 'no_show'] as const;
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];

export const RECOMMENDATIONS = ['strong_yes', 'yes', 'no', 'strong_no'] as const;
export type Recommendation = (typeof RECOMMENDATIONS)[number];

export const OFFER_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'revoked'] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export const CANDIDATE_ACTIVITY_TYPES = [
  'note', 'call', 'email', 'whatsapp', 'stage_change', 'interview', 'feedback', 'offer', 'document', 'system',
] as const;
export type CandidateActivityType = (typeof CANDIDATE_ACTIVITY_TYPES)[number];
/** Activity types a person may log by hand (the rest are written by the system). */
export const MANUAL_ACTIVITY_TYPES = ['note', 'call', 'email', 'whatsapp'] as const;

/** Standard hiring funnel seeded per org on first use. */
export const DEFAULT_STAGES: { name: string; order: number; kind: StageKind; color: string; isDefault: boolean }[] = [
  { name: 'Sourced', order: 1, kind: 'active', color: '#94A3B8', isDefault: true },
  { name: 'Screening', order: 2, kind: 'active', color: '#38BDF8', isDefault: false },
  { name: 'Shortlisted', order: 3, kind: 'active', color: '#6366F1', isDefault: false },
  { name: 'Interview', order: 4, kind: 'active', color: '#A855F7', isDefault: false },
  { name: 'Final Round', order: 5, kind: 'active', color: '#EC4899', isDefault: false },
  { name: 'Offer', order: 6, kind: 'active', color: '#F59E0B', isDefault: false },
  { name: 'Hired', order: 7, kind: 'hired', color: '#22C55E', isDefault: false },
  { name: 'Rejected', order: 8, kind: 'rejected', color: '#EF4444', isDefault: false },
];

export const DEFAULT_REJECTION_REASONS = [
  'Skills mismatch',
  'Insufficient experience',
  'Overqualified',
  'Salary expectations too high',
  'Notice period too long',
  'Location / relocation constraint',
  'Poor communication',
  'Failed technical round',
  'Culture fit',
  'Candidate withdrew',
  'Not reachable',
  'Position filled',
];

export const DEFAULT_SCORECARD_CRITERIA = [
  'Technical skills',
  'Problem solving',
  'Communication',
  'Relevant experience',
  'Culture fit',
];

/** Notification types emitted by this module. */
export const RECRUITMENT_NOTIFICATIONS = {
  CANDIDATE_ASSIGNED: 'recruitment_candidate_assigned',
  STAGE_CHANGED: 'recruitment_stage_changed',
  INTERVIEW_SCHEDULED: 'recruitment_interview_scheduled',
  INTERVIEW_CANCELLED: 'recruitment_interview_cancelled',
  FEEDBACK_DUE: 'recruitment_feedback_due',
  FEEDBACK_SUBMITTED: 'recruitment_feedback_submitted',
  OFFER_ACCEPTED: 'recruitment_offer_accepted',
} as const;
