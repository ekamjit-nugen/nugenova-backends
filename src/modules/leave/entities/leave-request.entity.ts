import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * LeaveRequest — an employee's leave application for a date range. Ported from
 * the legacy `leaves` collection. `userId` is the auth user id (same key
 * attendance/onboarding use — Nexora has no separate HR Employee).
 *
 * Lifecycle: pending → approved | rejected | cancelled. Balance is deducted at
 * APPROVAL (not apply) and restored on cancel of an approved leave — see
 * LeaveService. Half-day forces `totalDays` to 0.5 and is single-day only.
 */
@Entity('leave_requests')
@Index('ix_leave_org_status', ['organizationId', 'status'])
@Index('ix_leave_org_user', ['organizationId', 'userId'])
@Index('ix_leave_user_dates', ['userId', 'startDate', 'endDate'])
export class LeaveRequestEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  /** Auth userId of the applicant. */
  @Column({ type: 'varchar', length: 24 })
  userId: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  employeeName: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  employeeEmail: string | null;

  /** casual | sick | earned | wfh | maternity | paternity | bereavement | comp_off | lop */
  @Column({ type: 'varchar' })
  leaveType: string;

  /** Inclusive day boundaries (single-day request has start === end). */
  @Column({ type: 'timestamptz' })
  startDate: Date;

  @Column({ type: 'timestamptz' })
  endDate: Date;

  /** Business days (weekends + holidays excluded); 0.5 for a half-day. */
  @Column({ type: 'numeric', precision: 5, scale: 1 })
  totalDays: number;

  @Column({ type: 'boolean', default: false })
  halfDay: boolean;

  /** first_half | second_half (only when halfDay). */
  @Column({ type: 'varchar', nullable: true, default: null })
  halfDaySlot: string | null;

  @Column({ type: 'text' })
  reason: string;

  /** pending | approved | rejected | cancelled */
  @Column({ type: 'varchar', default: 'pending' })
  status: string;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  reviewedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  reviewedAt: Date | null;

  /** Rejection reason or cancellation note. */
  @Column({ type: 'text', nullable: true, default: null })
  reviewNote: string | null;

  @Column({ type: 'boolean', default: false })
  isDeleted: boolean;
}
