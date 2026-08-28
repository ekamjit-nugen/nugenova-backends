import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * WfhRequest — a work-from-home request an employee raises for a date range.
 * WFH is no longer self-declared at clock-in: the employee **requests** it, an
 * owner/HR **approves** it, and only then does a clock-in on a covered day count
 * as WFH (skipping the office geo-fence). `startDate`/`endDate` are inclusive
 * day boundaries; a single-day request has them equal.
 *
 * State: pending → approved | rejected. `reviewedBy` / `reviewNote` capture the
 * decision. Org-scoped throughout; `userId` is the auth userId (same key
 * attendance records use).
 */
@Entity('wfh_requests')
@Index('ix_wfh_org_status', ['organizationId', 'status'])
@Index('ix_wfh_org_user', ['organizationId', 'userId'])
@Index('ix_wfh_user_dates', ['userId', 'startDate', 'endDate'])
export class WfhRequestEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  userId: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  employeeName: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  employeeEmail: string | null;

  /** Inclusive day boundaries (a single-day request has start === end). */
  @Column({ type: 'timestamptz' })
  startDate: Date;

  @Column({ type: 'timestamptz' })
  endDate: Date;

  @Column({ type: 'text', nullable: true, default: null })
  reason: string | null;

  /** pending | approved | rejected */
  @Column({ type: 'varchar', default: 'pending' })
  status: string;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  reviewedBy: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  reviewNote: string | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  reviewedAt: Date | null;

  @Column({ type: 'boolean', default: false })
  isDeleted: boolean;
}
