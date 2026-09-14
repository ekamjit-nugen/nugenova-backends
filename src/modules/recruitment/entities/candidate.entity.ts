import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';
import { CandidateSource, CandidateStatus, NoticeStatus } from '../recruitment.constants';
import type { EducationEntry, WorkEntry } from '../recruitment.utils';

/**
 * A person in the talent pool — one row per human, independent of how many
 * openings they're applied to (see `candidate_applications`). Org-scoped.
 * `emailNorm` / `phoneNorm` are unique per org (partial, not-deleted) so the
 * same person can't be entered twice. A `search_tsv` generated column (created
 * in the migration, not mapped here) powers full-text search over the profile
 * and the primary CV's text (`resumeText`).
 */
@Entity('candidates')
@Index('ix_candidates_org_status', ['organizationId', 'status'])
@Index('ix_candidates_org_owner', ['organizationId', 'ownerId'])
export class CandidateEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar' })
  fullName: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  email: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  emailNorm: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  phone: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  phoneNorm: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  altPhone: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  currentLocation: string | null;

  @Column({ type: 'jsonb', nullable: false, default: () => `'[]'::jsonb` })
  preferredLocations: string[];

  @Column({ type: 'boolean', nullable: true, default: null })
  willingToRelocate: boolean | null;

  @Column({ type: 'int', nullable: true, default: null })
  totalExpMonths: number | null;

  @Column({ type: 'int', nullable: true, default: null })
  relevantExpMonths: number | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  currentCompany: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  currentDesignation: string | null;

  /** Annual CTC in `currency`. Hidden from users without recruitment:edit. */
  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true, default: null })
  currentCtc: string | null;

  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true, default: null })
  expectedCtc: string | null;

  @Column({ type: 'varchar', default: 'INR' })
  currency: string;

  @Column({ type: 'int', nullable: true, default: null })
  noticePeriodDays: number | null;

  @Column({ type: 'varchar', default: 'unknown' })
  noticeStatus: NoticeStatus;

  @Column({ type: 'date', nullable: true, default: null })
  lastWorkingDay: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  highestQualification: string | null;

  @Column({ type: 'jsonb', nullable: false, default: () => `'[]'::jsonb` })
  education: EducationEntry[];

  @Column({ type: 'jsonb', nullable: false, default: () => `'[]'::jsonb` })
  workHistory: WorkEntry[];

  @Column({ type: 'jsonb', nullable: false, default: () => `'[]'::jsonb` })
  skills: string[];

  @Column({ type: 'varchar', nullable: true, default: null })
  linkedinUrl: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  githubUrl: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  portfolioUrl: string | null;

  @Column({ type: 'varchar', default: 'other' })
  source: CandidateSource;

  /** Free-text detail (e.g. referral name, agency, legacy sheet label). */
  @Column({ type: 'varchar', nullable: true, default: null })
  sourceDetail: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  referredBy: string | null;

  /** The CV link from before the platform (Google Drive etc.). */
  @Column({ type: 'varchar', nullable: true, default: null })
  externalResumeUrl: string | null;

  @Column({ type: 'jsonb', nullable: false, default: () => `'[]'::jsonb` })
  tags: string[];

  /** Recruiter's 0–5 star rating. */
  @Column({ type: 'int', nullable: true, default: null })
  rating: number | null;

  @Column({ type: 'text', nullable: true, default: null })
  aiSummary: string | null;

  /** Plain text of the primary CV (feeds search_tsv). Not selected by default. */
  @Column({ type: 'text', nullable: true, default: null, select: false })
  resumeText: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  ownerId: string | null;

  @Column({ type: 'varchar', default: 'active' })
  status: CandidateStatus;

  /** When the candidate consented to their data being kept (DPDP / GDPR). */
  @Column({ type: 'timestamptz', nullable: true, default: null })
  consentAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  lastActivityAt: Date | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
