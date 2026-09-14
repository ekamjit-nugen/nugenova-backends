import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';
import { OfferStatus } from '../recruitment.constants';

/** An offer made on an application; handed off to Onboarding once accepted. */
@Entity('candidate_offers')
@Index('ix_cand_offers_org_status', ['organizationId', 'status'])
@Index('ix_cand_offers_app', ['organizationId', 'applicationId'])
export class CandidateOfferEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  applicationId: string;

  @Column({ type: 'varchar', length: 24 })
  candidateId: string;

  @Column({ type: 'varchar', length: 24 })
  openingId: string;

  @Column({ type: 'varchar' })
  designation: string;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  departmentId: string | null;

  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true, default: null })
  offeredCtc: string | null;

  @Column({ type: 'varchar', default: 'INR' })
  currency: string;

  @Column({ type: 'date', nullable: true, default: null })
  joiningDate: string | null;

  @Column({ type: 'date', nullable: true, default: null })
  expiresOn: string | null;

  @Column({ type: 'varchar', default: 'draft' })
  status: OfferStatus;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  offerLetterFileId: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  notes: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  declineReason: string | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  sentAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  respondedAt: Date | null;

  /** Org membership created at handoff (links the hire to their employee record). */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  membershipId: string | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  handedOffAt: Date | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
