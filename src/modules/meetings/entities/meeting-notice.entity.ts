import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * "This person has dealt with the join prompt for this meeting" — one row per
 * (meeting, user). Written when they join or dismiss the popup, so the prompt
 * never comes back for them: on another device, after signing out and in again,
 * or after clearing browser storage.
 */
@Entity('meeting_notices')
@Index('ux_meeting_notice', ['meetingId', 'userId'], { unique: true })
@Index('ix_meeting_notice_user', ['userId'])
export class MeetingNoticeEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  meetingId: string;

  @Column({ type: 'varchar', length: 24 })
  userId: string;

  /** joined | dismissed */
  @Column({ type: 'varchar', length: 16, default: 'dismissed' })
  action: string;
}
