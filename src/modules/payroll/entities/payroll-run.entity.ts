import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/** Run lifecycle states (Phase B). Draft → review → approved → finalized; cancel from any non-final. */
export type PayrollRunStatus = 'draft' | 'review' | 'approved' | 'finalized' | 'cancelled';

/** Roll-up totals baked onto the run for the list/summary views (rupees). */
export interface PayrollRunTotals {
  employees: number;
  grossEarnings: number;
  totalDeductions: number;
  netPay: number;
  employerContributions: number;
}

/**
 * PayrollRun — the governed unit of a monthly payroll (Phase B). One non-cancelled
 * run per (org, month, year). The run carries the lifecycle + maker-checker audit;
 * its payslips are created as `draft` on process and flipped to `final` on finalize
 * (so nothing reaches employees until an approver ≠ the preparer has signed off).
 *
 * Money in RUPEES. `runNumber` is a human handle `PR-YYYY-MM-NN`.
 */
@Entity('payroll_runs')
@Index('ux_payroll_run_period', ['organizationId', 'year', 'month', 'isDeleted'])
export class PayrollRunEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'int' })
  month: number; // 1-12

  @Column({ type: 'int' })
  year: number;

  @Column({ type: 'varchar', length: 20 })
  runNumber: string;

  @Column({ type: 'varchar', default: 'draft' })
  status: PayrollRunStatus;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  totals: PayrollRunTotals;

  // ── maker-checker audit (separation of duties) ────────────────────────────────
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  preparedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  preparedAt: Date | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  approvedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  approvedAt: Date | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  finalizedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  finalizedAt: Date | null;

  @Column({ type: 'text', nullable: true, default: null })
  note: string | null;

  @Column({ type: 'boolean', default: false })
  isDeleted: boolean;
}
