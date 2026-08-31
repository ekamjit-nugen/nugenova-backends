import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/** A salary earning component (Basic, HRA, allowances). Amounts in rupees/month. */
export interface SalaryComponent {
  code: string; // e.g. BASIC, HRA, SPECIAL
  name: string;
  amount: number;
}

/**
 * SalaryStructure — an employee's monthly salary (Phase 1: the "simple" path — a
 * single fixed monthly figure in RUPEES, no CTC breakdown). Effective-dated with
 * supersede-on-write: at most one `isActive` row per employee; editing supersedes
 * the prior one. `userId` is the auth user id (Nexora has no separate HR entity).
 *
 * Full CTC component breakdown + statutory config is a later phase.
 */
@Entity('salary_structures')
@Index('ix_salary_org_user', ['organizationId', 'userId'])
@Index('ix_salary_org_active', ['organizationId', 'isActive'])
export class SalaryStructureEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  userId: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  employeeName: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  employeeEmail: string | null;

  /** Monthly gross salary in rupees (= sum of components when a breakdown exists). */
  @Column({ type: 'numeric', precision: 12, scale: 2 })
  monthlySalary: number;

  /** Earning breakdown; empty ⇒ treat the whole `monthlySalary` as Basic. */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  components: SalaryComponent[];

  @Column({ type: 'timestamptz' })
  effectiveFrom: Date;

  /** The active structure this one superseded (revision chain). */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  supersedes: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'boolean', default: false })
  isDeleted: boolean;
}
