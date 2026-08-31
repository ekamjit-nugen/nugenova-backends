import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/** One per-type balance line inside a year's balance doc. */
export interface LeaveBalanceLine {
  leaveType: string;
  opening: number;
  accrued: number;
  used: number;
  adjusted: number;
  carriedForward: number;
  available: number;
}

/**
 * LeaveBalance — one row per (organization, user, year) holding a per-type
 * balance array. Ported from the legacy `leavebalances` collection. Invariant
 * (recomputed on every mutation):
 *   available = opening + accrued + adjusted + carriedForward − used
 *
 * Allocation is granted up-front into `opening` from the leave-type catalog
 * (accrual/carry-forward are not executed yet — matching legacy).
 */
@Entity('leave_balances')
@Index('ux_leave_balance_user_year', ['userId', 'year'], { unique: true })
@Index('ix_leave_balance_org_year', ['organizationId', 'year'])
export class LeaveBalanceEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  userId: string;

  @Column({ type: 'int' })
  year: number;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  balances: LeaveBalanceLine[];
}
