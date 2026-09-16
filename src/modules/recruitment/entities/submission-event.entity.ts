import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';
import type { SubmissionStatus } from '../submission-rules';

/** Append-only status trail for a client submission. */
@Entity('recruitment_submission_events')
@Index('ix_rec_submission_events_sub', ['organizationId', 'submissionId', 'at'])
export class SubmissionEventEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  submissionId: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  fromStatus: SubmissionStatus | null;

  @Column({ type: 'varchar' })
  toStatus: SubmissionStatus;

  @Column({ type: 'text', nullable: true, default: null })
  note: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  byUserId: string | null;

  @Column({ type: 'timestamptz' })
  at: Date;
}
