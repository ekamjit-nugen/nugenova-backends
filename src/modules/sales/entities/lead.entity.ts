import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';
import { LeadSource, LeadStatus } from '../sales.constants';

/**
 * A sales lead — the single record for a prospective piece of work. Org-scoped.
 * Holds the pipeline position, the money the lead is worth (`value`), a rich-text
 * `requirement` write-up, attached docs (see `sales_lead_documents`), a structured
 * effort estimate (`sales_requirements`), quotes, and — once won — a bridge to the
 * delivery Clients module (`clientId`). There is no separate "deal" record.
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

  /** Free-text source label when `source` is 'other'. */
  @Column({ type: 'varchar', nullable: true, default: null })
  sourceDetail: string | null;

  /** The existing client this lead came from, when `source` is 'client'. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  sourceClientId: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  stageId: string | null;

  @Column({ type: 'varchar', default: 'open' })
  status: LeadStatus;

  /** What the lead is worth — the amount they'll pay for the job (drives forecasting). */
  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true, default: null })
  value: string | null;

  /** Rich-text requirement write-up (sanitized HTML). */
  @Column({ type: 'text', nullable: true, default: null })
  requirement: string | null;

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

  /** Stamped when the lead reaches a won stage (feeds won-revenue analytics). */
  @Column({ type: 'timestamptz', nullable: true, default: null })
  wonAt: Date | null;

  /** Set when a won lead is onboarded into the delivery Clients module. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  clientId: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
