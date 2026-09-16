import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';
import { OpeningStatus } from '../recruitment.constants';

/** A job opening (requisition) candidates are applied to. Org-scoped. */
@Entity('recruitment_openings')
@Index('ix_rec_openings_org_status', ['organizationId', 'status'])
export class RecruitmentOpeningEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar' })
  title: string;

  /** Short human code, e.g. "DE-01" (optional, unique per org when set). */
  @Column({ type: 'varchar', nullable: true, default: null })
  code: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  departmentId: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  location: string | null;

  @Column({ type: 'varchar', default: 'onsite' })
  workMode: string;

  @Column({ type: 'varchar', default: 'full_time' })
  employmentType: string;

  @Column({ type: 'int', nullable: true, default: null })
  expMinYears: number | null;

  @Column({ type: 'int', nullable: true, default: null })
  expMaxYears: number | null;

  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true, default: null })
  budgetMin: string | null;

  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true, default: null })
  budgetMax: string | null;

  @Column({ type: 'varchar', default: 'INR' })
  currency: string;

  @Column({ type: 'int', default: 1 })
  positions: number;

  @Column({ type: 'jsonb', nullable: false, default: () => `'[]'::jsonb` })
  skills: string[];

  /** Rich-text job description (sanitized HTML). */
  @Column({ type: 'text', nullable: true, default: null })
  description: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  hiringManagerId: string | null;

  @Column({ type: 'jsonb', nullable: false, default: () => `'[]'::jsonb` })
  recruiterIds: string[];

  @Column({ type: 'varchar', default: 'open' })
  status: OpeningStatus;

  @Column({ type: 'varchar', default: 'medium' })
  priority: string;

  @Column({ type: 'date', nullable: true, default: null })
  targetDate: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  scorecardTemplateId: string | null;

  /** Raised from a Sales lead requirement (staffing demand). */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  leadId: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  requirementId: string | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  openedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  closedAt: Date | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
