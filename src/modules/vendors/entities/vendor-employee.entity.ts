import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

export type VendorEmploymentType = 'contract' | 'full_time' | 'part_time' | 'freelance';
export type VendorEmployeeStatus = 'active' | 'inactive';
export type RateUnit = 'hour' | 'day' | 'month';

/**
 * A contractor supplied by a vendor — the person who actually does the work.
 *
 * They are NOT an employee of ours: no payslip, no leave balance, no seat. The
 * one place they may meet our system is attendance, and only when the vendor has
 * `timeTrackingEnabled` — `attendance.vendor_employee_id` has been reserved for
 * that since the first migration. If they ever get a login it is a membership
 * with `personType = 'vendor'`, which `staffScope()` keeps out of every
 * staff-assuming query (payroll runs, the roster, headcount).
 *
 * `rateAmount`/`rateUnit` are what the VENDOR charges us, kept per person
 * because staffing rates differ by individual. Billing reads it in Phase 2.
 */
@Entity('vendor_employees')
@Index('ix_vendor_employees_vendor', ['vendorId'])
@Index('ix_vendor_employees_org_status', ['organizationId', 'status'])
export class VendorEmployeeEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  vendorId: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  email: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  phone: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  designation: string | null;

  @Column({ type: 'jsonb', nullable: false, default: () => `'[]'::jsonb` })
  skills: string[];

  @Column({ type: 'varchar', default: 'contract' })
  employmentType: VendorEmploymentType;

  @Column({ type: 'varchar', default: 'active' })
  status: VendorEmployeeStatus;

  /** numeric, not float: money. Null until the rate is agreed. */
  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true, default: null, transformer: {
    to: (v: number | null) => v,
    from: (v: string | null) => (v === null || v === undefined ? null : Number(v)),
  } })
  rateAmount: number | null;

  @Column({ type: 'varchar', default: 'INR' })
  rateCurrency: string;

  @Column({ type: 'varchar', default: 'day' })
  rateUnit: RateUnit;

  /** Auth userId if this contractor was given a login; null = record only. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  linkedUserId: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  notes: string | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
