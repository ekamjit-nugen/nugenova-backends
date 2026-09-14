import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

export type MeetingStatus = 'scheduled' | 'live' | 'ended' | 'cancelled';
export type MeetingRecurrence = 'none' | 'daily' | 'weekly';

/** A participant reference stored on the meeting (denormalised name for display). */
export interface MeetingParticipant {
  userId: string;
  name: string;
}

/**
 * A video meeting, powered by Jitsi. Our app owns scheduling, invites, access
 * control and lifecycle; the actual A/V room is a Jitsi room keyed by
 * {@link roomName}. The room name is long + org-scoped so it is effectively
 * unguessable on a shared Jitsi deployment (e.g. meet.jit.si).
 */
@Entity('meetings')
@Index('ix_meetings_org', ['organizationId'])
@Index('ix_meetings_host', ['hostId'])
@Index('ix_meetings_start', ['scheduledStart'])
export class MeetingEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'text', nullable: true, default: null })
  description: string | null;

  /** The meeting host (creator) — holds moderator powers in the room. */
  @Column({ type: 'varchar', length: 24 })
  hostId: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  hostName: string | null;

  /** Jitsi room identifier (unique, unguessable). */
  @Column({ type: 'varchar', unique: true })
  roomName: string;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  scheduledStart: Date | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  scheduledEnd: Date | null;

  @Column({ type: 'varchar', default: 'scheduled' })
  status: MeetingStatus;

  /** Started immediately ("meet now") rather than scheduled for later. */
  @Column({ type: 'boolean', default: false })
  isInstant: boolean;

  /** Recurring cadence — a recurring meeting reuses the same room and is never
   *  auto-ended after a single occurrence. */
  @Column({ type: 'varchar', default: 'none' })
  recurrence: MeetingRecurrence;

  @Column({ type: 'jsonb', nullable: false, default: () => `'[]'::jsonb` })
  participants: MeetingParticipant[];

  /** Enable Jitsi's lobby (waiting room) — guests wait for the host to admit. */
  @Column({ type: 'boolean', default: true })
  lobbyEnabled: boolean;

  /** Optional room passcode (set by the host in-call; stored for reference). */
  @Column({ type: 'varchar', nullable: true, default: null })
  passcode: string | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  startedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  endedAt: Date | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
