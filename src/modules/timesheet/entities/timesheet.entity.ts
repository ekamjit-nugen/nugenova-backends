import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

export type TimesheetStatus = 'draft' | 'submitted' | 'approved' | 'rejected';
export type TimesheetCadence = 'weekly' | 'monthly';

/** One day's logged time on a timesheet. */
export interface TimesheetEntry {
  /** YYYY-MM-DD (the org-local calendar day). */
  date: string;
  /** Hours worked that day. */
  hours: number;
  note?: string;
}

/**
 * Timesheet — an employee's logged time for a period (a week or a month, per the
 * org's timesheet policy), submitted for a manager's approval. Days are
 * pre-filled from attendance and (if the policy allows) editable before submit.
 * One timesheet per (org, employee, periodStart).
 */
@Entity('timesheets')
@Index('ux_timesheet_period', ['organizationId', 'userId', 'periodStart', 'isDeleted'])
@Index('ix_timesheet_org_status', ['organizationId', 'status'])
export class TimesheetEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  userId: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  employeeName: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  employeeEmail: string | null;

  @Column({ type: 'varchar', default: 'monthly' })
  cadence: TimesheetCadence;

  @Column({ type: 'timestamptz' })
  periodStart: Date;

  @Column({ type: 'timestamptz' })
  periodEnd: Date;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  entries: TimesheetEntry[];

  @Column({ type: 'numeric', precision: 8, scale: 2, default: 0 })
  totalHours: number;

  @Column({ type: 'varchar', default: 'draft' })
  status: TimesheetStatus;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  submittedAt: Date | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  reviewedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  reviewedAt: Date | null;

  @Column({ type: 'text', nullable: true, default: null })
  reviewNote: string | null;

  @Column({ type: 'boolean', default: false })
  isDeleted: boolean;
}
