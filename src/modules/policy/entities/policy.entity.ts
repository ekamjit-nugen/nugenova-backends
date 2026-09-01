import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/** Work-timing config — defines the working day (drives clock-in status). */
export interface WorkTimingConfig {
  startTime?: string; // 'HH:MM'
  endTime?: string;
  timezone?: string;
  graceMinutes?: number;
  minWorkingHours?: number;
  breakMinutes?: number;
  lateToHalfDayMinutes?: number;
  minHoursForPresent?: number;
  isNightShift?: boolean;
}

export interface OfficeLocation {
  name?: string | null;
  latitude: number;
  longitude: number;
  radiusKm?: number | null;
}

/** Work-location config — office geo-fence / home / hybrid. */
export interface WorkLocationConfig {
  mode?: 'office' | 'home' | 'hybrid';
  geoFenceRadiusKm?: number;
  offices?: OfficeLocation[];
}

/** WFH config — which days and how many per month WFH is allowed. */
export interface WfhConfig {
  maxDaysPerMonth?: number; // 0 / unset = no cap
  requiresApproval?: boolean;
  allowedDays?: string[]; // lowercase weekday names
}

/** A document attached to a policy (uploaded via /media/upload, stored by id). */
export interface PolicyAttachment {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  uploadedAt: string;
}

/**
 * The org's category enum. Only the attendance-governing categories are
 * exercised in this phase (`working_hours`/`attendance`/`shift` carry a
 * `workTiming`); the rest are accepted and stored (in `extraConfig`) so leave /
 * overtime / holiday / payroll modules can build on them as they migrate.
 */
export const POLICY_CATEGORIES = [
  'attendance',
  'working_hours',
  'leave',
  'wfh',
  'overtime',
  'shift',
  'invoices',
  'expenses',
  'exemptions',
  'travel',
  'reimbursement',
  'payroll_override',
  'payroll',
  'holiday',
  'probation',
  'onboarding',
] as const;
export type PolicyCategory = (typeof POLICY_CATEGORIES)[number];

/** Categories whose `workTiming` governs an employee's clock-in status. */
export const TIMING_CATEGORIES = ['working_hours', 'attendance', 'shift'];

export type Applicability = 'all' | 'department' | 'designation' | 'specific';

/**
 * Policy — the org's rulebook. Ported from the Nugenova monolith Policy schema,
 * scoped in this phase to the attendance-governing surface (workTiming +
 * workLocation + wfhConfig) with an `extraConfig` jsonb catch-all reserving the
 * other category blobs (leave/overtime/holiday/…) for later modules.
 *
 * `organizationId` nullable: a null-org policy is a GLOBAL TEMPLATE
 * (`isTemplate` = true, inactive) seeded once and cloned into an org. A live org
 * policy always has a non-null org id. Applicability targets an employee by
 * `all` / department / designation(role) / specific(userId); `excludedEmployeeIds`
 * opts a user out of an otherwise-matching policy.
 *
 * Versioning is simplified to an in-place `version` bump (the monolith kept a
 * copy-on-write chain; consumers only ever read the latest, which the live row
 * is). A bump re-arms acknowledgement.
 */
@Entity('policies')
@Index('ix_policy_org_deleted', ['organizationId', 'isDeleted'])
@Index('ix_policy_org_category', ['organizationId', 'category'])
@Index('ix_policy_template', ['isTemplate'])
export class PolicyEntity extends PgBaseEntity {
  @Index()
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  organizationId: string | null;

  @Column({ type: 'varchar' })
  policyName: string;

  @Column({ type: 'text', nullable: true, default: null })
  description: string | null;

  @Column({ type: 'varchar' })
  category: PolicyCategory;

  @Column({ type: 'jsonb', nullable: true, default: null })
  workTiming: WorkTimingConfig | null;

  @Column({ type: 'jsonb', nullable: true, default: null })
  workLocation: WorkLocationConfig | null;

  @Column({ type: 'jsonb', nullable: true, default: null })
  wfhConfig: WfhConfig | null;

  /** Other category configs (leave/overtime/holiday/…), untyped until migrated. */
  @Column({ type: 'jsonb', nullable: true, default: null })
  extraConfig: Record<string, unknown> | null;

  /** Attached documents (PDF/etc.) — refs into the media/storage store. */
  @Column({ type: 'jsonb', nullable: true, default: null })
  attachments: PolicyAttachment[] | null;

  @Column({ type: 'varchar', default: 'all' })
  applicableTo: Applicability;

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  applicableIds: string[];

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  excludedEmployeeIds: string[];

  @Column({ type: 'timestamptz', nullable: true, default: null })
  effectiveFrom: Date | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  effectiveTo: Date | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  reviewDate: Date | null;

  @Column({ type: 'int', default: 1 })
  version: number;

  @Column({ type: 'boolean', default: false })
  isTemplate: boolean;

  @Column({ type: 'varchar', nullable: true, default: null })
  templateName: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  sourceTemplateId: string | null;

  @Column({ type: 'boolean', default: false })
  acknowledgementRequired: boolean;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'boolean', default: false })
  isDeleted: boolean;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  updatedBy: string | null;
}
