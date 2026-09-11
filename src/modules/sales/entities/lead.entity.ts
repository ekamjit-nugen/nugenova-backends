import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';
import { LeadSource, LeadStatus } from '../sales.constants';

/**
 * A sales lead — a prospective customer moving through the pipeline. Org-scoped.
 * `company` is free text at this stage; once qualified it can be linked to an
 * account/contact (Phase 1b) and converted to a deal (Phase 2).
 */
@Entity('leads')
@Index('ix_leads_org_status', ['organizationId', 'status'])
@Index('ix_leads_org_stage', ['organizationId', 'stageId'])
@Index('ix_leads_org_assigned', ['organizationId', 'assignedTo'])
export class LeadEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  company: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  email: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  phone: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  title: string | null;

  @Column({ type: 'varchar', default: 'other' })
  source: LeadSource;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  stageId: string | null;

  @Column({ type: 'varchar', default: 'open' })
  status: LeadStatus;

  /** Estimated deal value (for pipeline weighting / forecasting). */
  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true, default: null })
  value: string | null;

  @Column({ type: 'varchar', default: 'INR' })
  currency: string;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  assignedTo: string | null;

  @Column({ type: 'int', default: 0 })
  score: number;

  @Column({ type: 'jsonb', nullable: false, default: () => `'[]'::jsonb` })
  tags: string[];

  @Column({ type: 'text', nullable: true, default: null })
  notes: string | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  lastActivityAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  nextFollowUpAt: Date | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  convertedToDealId: string | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  convertedAt: Date | null;

  /** Set when a won lead is onboarded into the Clients module (Phase 3 bridge). */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  clientId: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
