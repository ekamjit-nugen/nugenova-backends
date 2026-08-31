import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/** The LOP/attendance breakdown baked onto the payslip (audit + display). */
export interface PayslipLopDetails {
  workingDays: number;
  presentDays: number;
  halfDays: number;
  paidLeaveDays: number;
  lopLeaveDays: number;
  absentDays: number;
  lopDays: number;
  payableDays: number;
  perDayPay: number;
}

/** A snapshot of who/what the payslip was generated for (immutable). */
export interface PayslipEmployeeSnapshot {
  userId: string;
  name: string | null;
  email: string | null;
  department: string | null;
  designation: string | null;
}
export interface PayslipOrgSnapshot {
  organizationId: string;
  name: string | null;
}

/**
 * Payslip — the immutable published artifact for one employee for one month.
 * Ported from the legacy `payslips` (simple source). Amounts in RUPEES. Unique on
 * (org, userId, year, month) — one payslip per employee per month. Snapshots the
 * employee/org so a later rename never changes a published slip; the PDF is a pure
 * function of this row (rendered on demand, not stored).
 */
@Entity('payslips')
@Index('ux_payslip_user_period', ['userId', 'year', 'month'], { unique: true })
@Index('ix_payslip_org_period', ['organizationId', 'year', 'month'])
export class PayslipEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  userId: string;

  @Column({ type: 'int' })
  month: number; // 1-12

  @Column({ type: 'int' })
  year: number;

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  monthlySalary: number;

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  grossEarnings: number;

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  lopDeduction: number;

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  totalDeductions: number;

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  netPay: number;

  @Column({ type: 'varchar', length: 300 })
  netPayWords: string;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  lopDetails: PayslipLopDetails;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  employeeSnapshot: PayslipEmployeeSnapshot;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  orgSnapshot: PayslipOrgSnapshot;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  generatedBy: string | null;

  @Column({ type: 'boolean', default: false })
  isDeleted: boolean;
}
