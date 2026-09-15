import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';
import { InterviewStatus } from '../recruitment.constants';

/** One interview round for an application. */
@Entity('recruitment_interviews')
@Index('ix_rec_interviews_org_time', ['organizationId', 'scheduledAt'])
@Index('ix_rec_interviews_app', ['organizationId', 'applicationId'])
export class InterviewEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  /** Internal rounds hang off an opening application… */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  applicationId: string | null;

  /** …client rounds hang off a lead submission. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  submissionId: string | null;

  @Column({ type: 'varchar', default: 'internal' })
  kind: 'internal' | 'client';

  /** Denormalised for fast "interviews for this candidate" reads. */
  @Column({ type: 'varchar', length: 24 })
  candidateId: string;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  openingId: string | null;

  @Column({ type: 'varchar' })
  roundName: string;

  @Column({ type: 'varchar', default: 'video' })
  type: string;

  @Column({ type: 'timestamptz' })
  scheduledAt: Date;

  @Column({ type: 'int', default: 60 })
  durationMin: number;

  @Column({ type: 'jsonb', nullable: false, default: () => `'[]'::jsonb` })
  interviewerIds: string[];

  @Column({ type: 'varchar', nullable: true, default: null })
  location: string | null;

  /** External link (Meet/Zoom) when not using the built-in meeting. */
  @Column({ type: 'varchar', nullable: true, default: null })
  meetingLink: string | null;

  /** Built-in Meetings module room, when created from here. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  meetingId: string | null;

  @Column({ type: 'jsonb', nullable: false, default: () => `'[]'::jsonb` })
  criteria: string[];

  @Column({ type: 'text', nullable: true, default: null })
  notes: string | null;

  @Column({ type: 'varchar', default: 'scheduled' })
  status: InterviewStatus;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  feedbackRemindedAt: Date | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
