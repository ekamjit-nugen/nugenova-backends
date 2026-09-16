/**
 * Domain-event registry — §08 layer 1 of the Institutional Platform plan.
 *
 * Every module EMITS typed domain events; nothing subscribes yet. Centralising
 * the event NAMES (and their payload shapes) here means the later automation
 * layer (nudges, digests, workflow rules) has one authoritative catalogue to
 * bind listeners to — modules never invent ad-hoc string names at the call site.
 *
 * Names are namespaced `<aggregate>.<pastTenseFact>` and are append-only: once a
 * name ships, listeners depend on it, so rename via a new name + deprecation
 * rather than editing an existing one.
 */

/** The canonical event-name catalogue. Keys are stable identifiers; values are
 *  the wire names emitted on the bus. */
export const DOMAIN_EVENTS = {
  // ── attendance ──────────────────────────────────────────────────────────
  ATTENDANCE_MARKED: 'attendance.marked',
  ATTENDANCE_SHORTFALL: 'attendance.shortfall',
  // ── fees / finance ──────────────────────────────────────────────────────
  FEE_OVERDUE: 'fee.overdue',
  // ── admissions / CRM ────────────────────────────────────────────────────
  ENQUIRY_CREATED: 'enquiry.created',
  ENQUIRY_STALE: 'enquiry.stale',
  ADMISSION_CONFIRMED: 'admission.confirmed',
  // ── assessment / gradebook ──────────────────────────────────────────────
  ASSESSMENT_GRADED: 'assessment.graded',
  // ── documents / compliance ──────────────────────────────────────────────
  DOCUMENT_EXPIRING: 'document.expiring',
  // ── academic / LMS ──────────────────────────────────────────────────────
  ENROLMENT_CREATED: 'enrolment.created',
  // ── recruitment ─────────────────────────────────────────────────────────
  CANDIDATE_CREATED: 'candidate.created',
  APPLICATION_STAGE_CHANGED: 'application.stageChanged',
  CANDIDATE_HIRED: 'candidate.hired',
  SUBMISSION_CREATED: 'submission.created',
  SUBMISSION_STATUS_CHANGED: 'submission.statusChanged',
} as const;

/** The union of every wire name the platform emits. */
export type DomainEventName = (typeof DOMAIN_EVENTS)[keyof typeof DOMAIN_EVENTS];

/**
 * Every domain-event payload carries the tenant it happened in and when — the
 * two fields every future listener (per-org routing, audit) needs. Concrete
 * payloads extend this.
 */
export interface DomainEventBase {
  /** The org (tenant) the event occurred in — always present for routing. */
  organizationId: string;
  /** When the fact occurred (defaulted to now() by the emitter if omitted). */
  occurredAt?: Date;
  /** The acting membership/user id, when a person triggered it. */
  actorId?: string | null;
}

// ── concrete payload shapes ───────────────────────────────────────────────

export interface AttendanceMarkedPayload extends DomainEventBase {
  membershipId: string;
  date: string;
  status: string;
}

export interface AttendanceShortfallPayload extends DomainEventBase {
  membershipId: string;
  requiredPercent: number;
  actualPercent: number;
}

export interface FeeOverduePayload extends DomainEventBase {
  subjectMembershipId: string;
  invoiceId: string;
  amountDue: number;
  dueDate: string;
}

export interface EnquiryCreatedPayload extends DomainEventBase {
  enquiryId: string;
  source?: string | null;
}

export interface EnquiryStalePayload extends DomainEventBase {
  enquiryId: string;
  staleForDays: number;
}

export interface AdmissionConfirmedPayload extends DomainEventBase {
  applicationId: string;
  studentMembershipId?: string | null;
}

export interface AssessmentGradedPayload extends DomainEventBase {
  assessmentId: string;
  studentMembershipId: string;
  classId?: string | null;
}

export interface DocumentExpiringPayload extends DomainEventBase {
  documentId: string;
  subjectMembershipId?: string | null;
  expiresOn: string;
}

export interface EnrolmentCreatedPayload extends DomainEventBase {
  enrolmentId: string;
  classId: string;
  studentMembershipId: string;
}

export interface CandidateCreatedPayload extends DomainEventBase {
  candidateId: string;
  source: string;
}

export interface ApplicationStageChangedPayload extends DomainEventBase {
  applicationId: string;
  candidateId: string;
  openingId: string;
  fromStageId: string | null;
  toStageId: string;
}

export interface CandidateHiredPayload extends DomainEventBase {
  applicationId: string;
  candidateId: string;
  openingId: string;
}

export interface SubmissionCreatedPayload extends DomainEventBase {
  submissionId: string;
  leadId: string;
  requirementId: string | null;
  candidateId: string;
}

export interface SubmissionStatusChangedPayload extends SubmissionCreatedPayload {
  fromStatus: string;
  toStatus: string;
}

/**
 * The compile-time map from an event NAME to its payload type. The
 * DomainEventsService `emit` is generic over this, so a mismatched payload is a
 * build error at the call site (the whole point of the typed wrapper).
 */
export interface DomainEventPayloads {
  [DOMAIN_EVENTS.ATTENDANCE_MARKED]: AttendanceMarkedPayload;
  [DOMAIN_EVENTS.ATTENDANCE_SHORTFALL]: AttendanceShortfallPayload;
  [DOMAIN_EVENTS.FEE_OVERDUE]: FeeOverduePayload;
  [DOMAIN_EVENTS.ENQUIRY_CREATED]: EnquiryCreatedPayload;
  [DOMAIN_EVENTS.ENQUIRY_STALE]: EnquiryStalePayload;
  [DOMAIN_EVENTS.ADMISSION_CONFIRMED]: AdmissionConfirmedPayload;
  [DOMAIN_EVENTS.ASSESSMENT_GRADED]: AssessmentGradedPayload;
  [DOMAIN_EVENTS.DOCUMENT_EXPIRING]: DocumentExpiringPayload;
  [DOMAIN_EVENTS.ENROLMENT_CREATED]: EnrolmentCreatedPayload;
  [DOMAIN_EVENTS.CANDIDATE_CREATED]: CandidateCreatedPayload;
  [DOMAIN_EVENTS.APPLICATION_STAGE_CHANGED]: ApplicationStageChangedPayload;
  [DOMAIN_EVENTS.CANDIDATE_HIRED]: CandidateHiredPayload;
  [DOMAIN_EVENTS.SUBMISSION_CREATED]: SubmissionCreatedPayload;
  [DOMAIN_EVENTS.SUBMISSION_STATUS_CHANGED]: SubmissionStatusChangedPayload;
}

/** An emitted envelope as it reaches a listener (payload + resolved metadata). */
export type DomainEventEnvelope<E extends DomainEventName> =
  DomainEventPayloads[E] & { event: E; occurredAt: Date };
