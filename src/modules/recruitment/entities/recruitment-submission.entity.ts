import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';
import type { BillUnit, SubmissionStatus } from '../submission-rules';

/**
 * A candidate put forward against a Sales lead (optionally a specific requirement).
 * The staffing pipeline on the client side: shortlisted → shared → client screening /
 * interview → selected → onboarded (or rejected / on hold / withdrawn). History lives
 * in `recruitment_submission_events`.
 */
@Entity('recruitment_submissions')
@Index('ix_rec_submissions_lead', ['organizationId', 'leadId', 'status'])
@Index('ix_rec_submissions_candidate', ['organizationId', 'candidateId'])
export class RecruitmentSubmissionEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  leadId: string;

  /** Null = submitted against the lead as a whole. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  requirementId: string | null;

  @Column({ type: 'varchar', length: 24 })
  candidateId: string;

  /** The opening pipeline the candidate came from, if any. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  applicationId: string | null;

  @Column({ type: 'varchar', default: 'shortlisted' })
  status: SubmissionStatus;

  /** What the client is billed per `billUnit`. */
  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true, default: null })
  billRate: string | null;

  @Column({ type: 'varchar', default: 'month' })
  billUnit: BillUnit;

  /** Our cost per `billUnit` (defaults from expected CTC). Hidden without recruitment:edit. */
  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true, default: null })
  costRate: string | null;

  @Column({ type: 'varchar', default: 'INR' })
  currency: string;

  @Column({ type: 'date', nullable: true, default: null })
  availableFrom: string | null;

  @Column({ type: 'date', nullable: true, default: null })
  proposedStart: string | null;

  /** The CV version shared with the client (`candidate_documents.id`). */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  sharedDocumentId: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  clientFeedback: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  rejectionReason: string | null;

  /** Recruiter driving this submission. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  ownerId: string | null;

  /** Sales owner of the lead at submission time. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  accountManagerId: string | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  submittedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  decidedAt: Date | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
