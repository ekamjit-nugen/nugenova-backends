import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';
import { ApplicationStatus } from '../recruitment.constants';

/** A candidate's candidacy for one opening — the card on the pipeline board. */
@Entity('candidate_applications')
@Index('ix_cand_apps_org_opening', ['organizationId', 'openingId', 'stageId'])
@Index('ix_cand_apps_candidate', ['organizationId', 'candidateId'])
export class CandidateApplicationEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  candidateId: string;

  @Column({ type: 'varchar', length: 24 })
  openingId: string;

  @Column({ type: 'varchar', length: 24 })
  stageId: string;

  @Column({ type: 'varchar', default: 'active' })
  status: ApplicationStatus;

  @Column({ type: 'varchar', nullable: true, default: null })
  rejectionReason: string | null;

  @Column({ type: 'timestamptz' })
  appliedAt: Date;

  @Column({ type: 'timestamptz' })
  stageChangedAt: Date;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  hiredAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  rejectedAt: Date | null;

  /** Recruiter driving this application. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  ownerId: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
