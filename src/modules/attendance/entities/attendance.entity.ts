import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';
import type { RecordStatus } from '../util/attendance-status';

/** One in/out pair for a single clock session (a day can have several). */
export interface WorkSegment {
  checkInTime: string; // ISO
  checkOutTime?: string | null;
  checkInIP?: string | null;
  checkOutIP?: string | null;
  checkInLocation?: GeoLocation | null;
  checkOutLocation?: GeoLocation | null;
}

export interface GeoLocation {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  address?: string | null;
}

/** Breadcrumb of the geo/work-location check applied at clock-in. */
export interface GeoCheck {
  mode: 'office' | 'home' | 'hybrid';
  verified: boolean | null;
  distanceKm?: number | null;
  officeName?: string | null;
}

/** A proposed self-correction to a closed record, pending manager review. */
export interface PendingEdit {
  proposedCheckInTime?: string | null;
  proposedCheckOutTime?: string | null;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  requestedBy: string;
  requestedAt: string;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  rejectionReason?: string | null;
}

export type EntryType = 'system' | 'manual' | 'regularization' | 'force';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | null;

/**
 * Attendance — one record per (org, employee, org-tz calendar day). `employeeId`
 * is the auth **userId** (JWT sub), NOT the HR employee `_id` (the two are
 * reconciled at read time, exactly as in the monolith). `date` is a UTC-midnight
 * anchor whose Y/M/D equal the org-local day (see tz-day.util) so a 02:00-local
 * clock-in buckets to the right day.
 *
 * Re-clocking in on the same day appends to `workSegments` rather than creating a
 * second row; `totalWorkingHours` sums the closed segments and the top-level
 * check-in/out mirror the first-in / last-out.
 *
 * A partial UNIQUE index enforces one live SYSTEM record per (org, employee,
 * day) — manual/regularization rows and soft-deleted rows are exempt so a
 * corrected day can co-exist. Ported from the monolith's Mongo partial index.
 */
@Entity('attendance')
@Index('uq_attendance_org_emp_day', ['organizationId', 'employeeId', 'date'], {
  unique: true,
  where: `"entry_type" = 'system' AND "is_deleted" = false`,
})
@Index('ix_attendance_emp_date', ['employeeId', 'date'])
@Index('ix_attendance_org_date', ['organizationId', 'date'])
@Index('ix_attendance_org_status', ['organizationId', 'status'])
export class AttendanceEntity extends PgBaseEntity {
  @Index()
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  organizationId: string | null;

  /** Auth userId (JWT sub) of the person this record belongs to. */
  @Index()
  @Column({ type: 'varchar', length: 24 })
  employeeId: string;

  /** Contractor attribution — null for regular staff. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  vendorId: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  vendorEmployeeId: string | null;

  /** The tz-anchored calendar-day key (UTC-midnight of the org-local day). */
  @Column({ type: 'timestamptz' })
  date: Date;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  checkInTime: Date | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  checkOutTime: Date | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  checkInIP: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  checkOutIP: string | null;

  @Column({ type: 'jsonb', nullable: true, default: null })
  checkInLocation: GeoLocation | null;

  @Column({ type: 'jsonb', nullable: true, default: null })
  checkOutLocation: GeoLocation | null;

  /** Per-session in/out pairs — one row, many segments. */
  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  workSegments: WorkSegment[];

  @Column({ type: 'jsonb', nullable: true, default: null })
  geoCheck: GeoCheck | null;

  @Column({ type: 'double precision', nullable: true, default: null })
  totalWorkingHours: number | null;

  @Column({ type: 'double precision', nullable: true, default: null })
  effectiveWorkingHours: number | null;

  @Column({ type: 'double precision', default: 0 })
  overtimeHours: number;

  @Column({ type: 'varchar', default: 'present' })
  status: RecordStatus;

  @Column({ type: 'boolean', default: false })
  isLateArrival: boolean;

  @Column({ type: 'int', default: 0 })
  lateByMinutes: number;

  @Column({ type: 'boolean', default: false })
  isEarlyDeparture: boolean;

  @Column({ type: 'int', default: 0 })
  earlyByMinutes: number;

  @Column({ type: 'boolean', default: false })
  isNightShift: boolean;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  appliedShiftPolicyId: string | null;

  @Column({ type: 'varchar', default: 'system' })
  entryType: EntryType;

  @Column({ type: 'varchar', nullable: true, default: null })
  approvalStatus: ApprovalStatus;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  approvedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  approvedAt: Date | null;

  @Column({ type: 'text', nullable: true, default: null })
  rejectionReason: string | null;

  @Column({ type: 'jsonb', nullable: true, default: null })
  pendingEdit: PendingEdit | null;

  @Column({ type: 'text', nullable: true, default: null })
  notes: string | null;

  @Column({ type: 'boolean', default: false })
  missedCheckout: boolean;

  @Column({ type: 'boolean', default: false })
  autoCheckedOut: boolean;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  missedCheckoutAt: Date | null;

  @Column({ type: 'boolean', default: false })
  isDeleted: boolean;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;
}
