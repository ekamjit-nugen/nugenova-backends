import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

export type DealStatus = 'open' | 'won' | 'lost';

/**
 * A deal / opportunity — a qualified revenue opportunity moving through the same
 * pipeline as leads. Usually created by converting a lead. Its `amount` can be
 * set directly or rolled up from its requirements' effort estimate.
 */
@Entity('deals')
@Index('ix_deals_org_status', ['organizationId', 'status'])
@Index('ix_deals_org_stage', ['organizationId', 'stageId'])
@Index('ix_deals_org_assigned', ['organizationId', 'assignedTo'])
export class DealEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  accountId: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  contactId: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  sourceLeadId: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  stageId: string | null;

  @Column({ type: 'varchar', default: 'open' })
  status: DealStatus;

  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true, default: null })
  amount: string | null;

  @Column({ type: 'varchar', default: 'INR' })
  currency: string;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  assignedTo: string | null;

  @Column({ type: 'jsonb', nullable: false, default: () => `'[]'::jsonb` })
  tags: string[];

  @Column({ type: 'text', nullable: true, default: null })
  notes: string | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  expectedCloseDate: Date | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  lastActivityAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  nextFollowUpAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  wonAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  lostAt: Date | null;

  /** Free-text reason a deal was lost (industry-standard loss tracking). */
  @Column({ type: 'varchar', nullable: true, default: null })
  lostReason: string | null;

  /** Set when a won deal is onboarded into the Clients module (Phase 3 bridge). */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  clientId: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
