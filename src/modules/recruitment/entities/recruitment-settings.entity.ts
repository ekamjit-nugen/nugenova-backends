import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/** Per-org recruitment settings (one row per org, created on first read). */
@Entity('recruitment_settings')
@Index('ux_rec_settings_org', ['organizationId'], { unique: true })
export class RecruitmentSettingsEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'jsonb', nullable: false, default: () => `'[]'::jsonb` })
  rejectionReasons: string[];

  /** Suggested tags shown in pickers. */
  @Column({ type: 'jsonb', nullable: false, default: () => `'[]'::jsonb` })
  tags: string[];

  /** Hours after an interview ends before interviewers get a feedback nudge. */
  @Column({ type: 'int', default: 2 })
  feedbackReminderHours: number;
}
