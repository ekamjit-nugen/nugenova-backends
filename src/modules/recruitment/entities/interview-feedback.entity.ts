import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';
import { Recommendation } from '../recruitment.constants';

/** One interviewer's scorecard for one interview (unique per interviewer). */
@Entity('recruitment_interview_feedback')
@Index('ix_rec_feedback_interview', ['organizationId', 'interviewId'])
export class InterviewFeedbackEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  interviewId: string;

  @Column({ type: 'varchar', length: 24 })
  interviewerId: string;

  /** criterion → 1..5 */
  @Column({ type: 'jsonb', nullable: false, default: () => `'{}'::jsonb` })
  ratings: Record<string, number>;

  @Column({ type: 'numeric', precision: 3, scale: 2, nullable: true, default: null })
  overallRating: string | null;

  @Column({ type: 'varchar' })
  recommendation: Recommendation;

  @Column({ type: 'text', nullable: true, default: null })
  strengths: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  concerns: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  notes: string | null;

  @Column({ type: 'timestamptz' })
  submittedAt: Date;
}
