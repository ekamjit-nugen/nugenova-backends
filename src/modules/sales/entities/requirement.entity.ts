import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';
import { SalesEntityType } from '../sales.constants';

export const REQUIREMENT_PRIORITIES = ['must_have', 'should_have', 'could_have', 'wont_have'] as const;
export const REQUIREMENT_STATUSES = ['open', 'in_progress', 'fulfilled', 'dropped'] as const;
export const REQUIREMENT_UNITS = ['hours', 'days', 'fixed'] as const;

/**
 * A scoped requirement / line of work on a lead or deal — the "what needs doing"
 * plus a first-class effort estimate (role · quantity · rate → amount). Rolls up
 * to a deal's total effort + value. MoSCoW priority.
 */
@Entity('sales_requirements')
@Index('ix_sales_requirements_entity', ['organizationId', 'entityType', 'entityId'])
export class RequirementEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar' })
  entityType: SalesEntityType;

  @Column({ type: 'varchar', length: 24 })
  entityId: string;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'text', nullable: true, default: null })
  details: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  category: string | null;

  /** Who does the work — e.g. "Senior Backend Engineer". */
  @Column({ type: 'varchar', nullable: true, default: null })
  role: string | null;

  @Column({ type: 'jsonb', nullable: false, default: () => `'[]'::jsonb` })
  skills: string[];

  @Column({ type: 'varchar', default: 'must_have' })
  priority: string;

  @Column({ type: 'varchar', default: 'open' })
  status: string;

  /** hours | days | fixed — the unit `quantity` and `rate` are expressed in. */
  @Column({ type: 'varchar', default: 'hours' })
  unit: string;

  /** Amount of work: number of hours/days (or 1 for a fixed-price line). */
  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0 })
  quantity: string;

  /** Rate per hour/day (or the fixed price when unit = fixed). */
  @Column({ type: 'numeric', precision: 14, scale: 2, default: 0 })
  rate: string;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  neededBy: Date | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  assignedTo: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
