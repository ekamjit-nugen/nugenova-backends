import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';
import { CandidateActivityType } from '../recruitment.constants';

/** The candidate timeline: notes, calls, stage changes, system events. */
@Entity('candidate_activities')
@Index('ix_cand_activities_candidate', ['organizationId', 'candidateId', 'occurredAt'])
export class CandidateActivityEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  candidateId: string;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  applicationId: string | null;

  @Column({ type: 'varchar' })
  type: CandidateActivityType;

  @Column({ type: 'text', nullable: true, default: null })
  body: string | null;

  @Column({ type: 'jsonb', nullable: true, default: null })
  meta: Record<string, unknown> | null;

  @Column({ type: 'timestamptz' })
  occurredAt: Date;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  byUserId: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  byUserName: string | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
