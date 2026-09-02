import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';

import {
  PolicyEntity,
  TIMING_CATEGORIES,
  WorkTimingConfig,
  WorkLocationConfig,
  WfhConfig,
} from './entities/policy.entity';
import { PolicyAcknowledgementEntity } from './entities/policy-acknowledgement.entity';
import { PolicyVersionEntity } from './entities/policy-version.entity';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { NotifierService } from '../notification/notifier.service';
import { isPolicyEffective, matchesApplicability, EmployeeScope } from './util/policy-eligibility';
import { DEFAULT_ORG_WORK_TIMING, POLICY_TEMPLATES } from './default-policies';
import {
  CreatePolicyDto,
  UpdatePolicyDto,
  PolicyQueryDto,
  CreateFromTemplateDto,
  UpdateOnboardingConfigDto,
} from './dto';
import {
  OnboardingConfig,
  ONBOARDING_DOCUMENT_CATALOG,
  ONBOARDING_CHECKLIST_CATALOG,
  PROFILE_FIELD_CATALOG,
  catalogByGroup,
  defaultOnboardingConfig,
  sanitizeProfileFields,
  sanitizeChecklist,
} from './onboarding-catalog';
import {
  LeaveConfig,
  StoredLeaveType,
  defaultLeaveConfig,
  resolveLeaveConfig,
  sanitizeLeaveConfig,
} from './leave-config';
import {
  defaultPayrollConfig,
  resolvePayrollConfig,
  sanitizePayrollConfig,
  ptStateOptions,
  lwfStateOptions,
  deductionBasisOptions,
  deductionTemplates,
  PayrollConfigInput,
} from './payroll-config';
import {
  TimesheetConfig,
  TimesheetConfigInput,
  resolveTimesheetConfig,
  sanitizeTimesheetConfig,
} from './timesheet-config';
import { PayrollStatutoryConfig } from '../payroll/statutory';

/** What attendance needs to govern a clock-in for one employee. */
export interface ResolvedWorkContext {
  policyId: string | null;
  policyName: string | null;
  workTiming: WorkTimingConfig | null;
  workLocation: WorkLocationConfig | null;
  wfhConfig: WfhConfig | null;
}

const byUpdatedAtDesc = (a: PolicyEntity, b: PolicyEntity) =>
  (b.updatedAt?.getTime() || 0) - (a.updatedAt?.getTime() || 0);

/**
 * Categories that exist only to carry an `extraConfig` singleton (timesheet
 * cadence, payroll rules, onboarding requirements). They are configured through
 * dedicated setup screens and must never appear in the policy CRUD grid.
 */
const CONFIG_ONLY_CATEGORIES = ['timesheet', 'payroll', 'onboarding'];

/**
 * The org OWNER is never a subject of the org's own policies — they author and
 * govern policies rather than being bound by them. So an owner is excluded from
 * applicability, the login acknowledgement gate, compliance counts and
 * policy-published notifications, even for an `all`-employees policy. (Only the
 * owner tier is exempt; admins/managers/employees are all normal subjects.)
 */
export function isPolicyExemptRole(role: string | null | undefined): boolean {
  return role === 'owner';
}

/**
 * PolicyService — the org rulebook. Every method is org-scoped from the acting
 * `orgId` (from the JWT, never the client), closing the monolith's cross-org
 * read/write leaks (version history + acknowledge were un-scoped there).
 *
 * `resolveForEmployee` is THE contract attendance consumes: it picks the single
 * work-timing policy that governs an employee's clock-in, by applicability
 * (specific ▸ department/designation ▸ all) within the effective window.
 */
@Injectable()
export class PolicyService {
  private readonly logger = new Logger(PolicyService.name);

  constructor(
    @InjectRepository(PolicyEntity)
    private readonly repo: Repository<PolicyEntity>,
    @InjectRepository(PolicyAcknowledgementEntity)
    private readonly acks: Repository<PolicyAcknowledgementEntity>,
    @InjectRepository(PolicyVersionEntity)
    private readonly versions: Repository<PolicyVersionEntity>,
    @InjectRepository(OrgMembershipEntity)
    private readonly memberships: Repository<OrgMembershipEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    private readonly notifier: NotifierService,
  ) {}

  /**
   * Announce a policy that has just gone live to the members it applies to. Only
   * the userId-resolvable audiences are notified here: `all` (every active member)
   * and `specific` (the listed userIds). Department/designation audiences are left
   * to the login acknowledgement gate. Never throws (fire-and-forget).
   */
  private async notifyPublished(
    policy: PolicyEntity,
    actorId: string,
  ): Promise<void> {
    try {
      if (!policy.isActive || policy.isTemplate) return;
      const orgId = policy.organizationId;
      if (!orgId) return;
      // The owner is never a policy subject, so never notified — even for `all`.
      const owners = await this.memberships.find({
        where: { organizationId: orgId, role: 'owner' },
      });
      const ownerIds = new Set(owners.map((m) => m.userId).filter(Boolean) as string[]);

      let recipientIds: string[] = [];
      if (policy.applicableTo === 'all') {
        const members = await this.memberships.find({
          where: { organizationId: orgId, status: 'active' },
        });
        recipientIds = members
          .filter((m) => !isPolicyExemptRole(m.role))
          .map((m) => m.userId)
          .filter(Boolean) as string[];
      } else if (policy.applicableTo === 'specific') {
        recipientIds = (policy.applicableIds || []).filter(Boolean);
      } else {
        return; // department/designation — covered by the acknowledgement gate
      }
      const excluded = new Set([...(policy.excludedEmployeeIds || []), ...ownerIds]);
      const ackLine = policy.acknowledgementRequired
        ? ' Please review and acknowledge it.'
        : '';
      for (const userId of recipientIds) {
        if (excluded.has(userId)) continue;
        await this.notifier.notify({
          organizationId: orgId,
          userId,
          actorId,
          type: 'policy_published',
          title: policy.acknowledgementRequired
            ? 'New policy to acknowledge'
            : 'New policy published',
          body: `"${policy.policyName}" is now in effect.${ackLine}`,
          data: { actionUrl: '/policies', policyId: policy.id },
          priority: policy.acknowledgementRequired ? 'high' : 'normal',
        });
      }
    } catch (err) {
      this.logger.error(`notifyPublished failed (policy=${policy.id}): ${String(err)}`);
    }
  }

  // ── seed: a default work-timing policy for a new org ────────────────────────

  /**
   * Seed the org's default work-timing policy (applicableTo: all) so a policy
   * ALWAYS governs every employee's clock-in from day one. Idempotent — skips if
   * an org-wide working_hours policy already exists.
   */
  async seedDefaultWorkTiming(orgId: string, createdBy: string): Promise<PolicyEntity | null> {
    const existing = await this.repo.findOne({
      where: {
        organizationId: orgId,
        category: 'working_hours',
        applicableTo: 'all',
        isDeleted: false,
      },
    });
    if (existing) return existing;
    const policy = this.repo.create({
      organizationId: orgId,
      policyName: 'Standard Work Timing',
      description: 'Default working day — applies to everyone until an override is added.',
      category: 'working_hours',
      workTiming: { ...DEFAULT_ORG_WORK_TIMING },
      applicableTo: 'all',
      applicableIds: [],
      excludedEmployeeIds: [],
      isActive: true,
      // Every member must consent to the working-hours policy before they can
      // use the platform (the login-time acceptance gate reads this).
      acknowledgementRequired: true,
      createdBy,
      updatedBy: createdBy,
    });
    const saved = await this.repo.save(policy);
    this.logger.log(`Seeded default work-timing policy for org ${orgId}`);
    return saved;
  }

  // ── CRUD ────────────────────────────────────────────────────────────────────

  async create(orgId: string, dto: CreatePolicyDto, userId: string): Promise<PolicyEntity> {
    const policy = this.repo.create({
      organizationId: orgId,
      policyName: dto.policyName.trim(),
      description: dto.description ?? null,
      attachments: this.normAttachments(dto.attachments),
      category: dto.category as PolicyEntity['category'],
      workTiming: dto.workTiming ?? null,
      workLocation: dto.workLocation ?? null,
      wfhConfig: dto.wfhConfig ?? null,
      applicableTo: dto.applicableTo ?? 'all',
      applicableIds: dto.applicableIds ?? [],
      excludedEmployeeIds: dto.excludedEmployeeIds ?? [],
      effectiveFrom: dto.effectiveFrom ? new Date(dto.effectiveFrom) : null,
      effectiveTo: dto.effectiveTo ? new Date(dto.effectiveTo) : null,
      acknowledgementRequired: dto.acknowledgementRequired ?? false,
      // A new policy is a DRAFT until explicitly activated — it never governs
      // attendance while inactive (the resolver filters isActive:true). The org's
      // auto-seeded default is created active separately (seedDefaultWorkTiming).
      isActive: dto.isActive ?? false,
      version: 1,
      createdBy: userId,
      updatedBy: userId,
    });
    const saved = await this.repo.save(policy);
    void this.notifyPublished(saved, userId);
    return saved;
  }

  async list(orgId: string, q: PolicyQueryDto = {}): Promise<PolicyEntity[]> {
    const where: any = { organizationId: orgId, isDeleted: false };
    if (q.category) where.category = q.category;
    // Config-singleton policies (timesheet/payroll/onboarding) carry an
    // `extraConfig` blob and are managed through dedicated setup screens — they
    // must not surface as editable cards in the policy CRUD grid.
    else where.category = Not(In(CONFIG_ONLY_CATEGORIES));
    if (typeof q.isActive === 'boolean') where.isActive = q.isActive;
    return this.repo.find({ where, order: { createdAt: 'DESC' } });
  }

  async get(orgId: string, id: string): Promise<PolicyEntity> {
    const policy = await this.repo.findOne({
      where: { id, organizationId: orgId, isDeleted: false },
    });
    if (!policy) throw new NotFoundException('Policy not found');
    return policy;
  }

  /**
   * Update in place. Any change other than a lone `isActive` toggle bumps the
   * version (re-arming acknowledgement). Simpler than the monolith's copy-on-
   * write chain but preserves the consumer-visible "latest version" semantics.
   */
  async update(orgId: string, id: string, dto: UpdatePolicyDto, userId: string): Promise<PolicyEntity> {
    const policy = await this.get(orgId, id);
    if (policy.isTemplate) throw new ForbiddenException('Templates cannot be edited');
    const wasActive = policy.isActive;

    const keys = Object.keys(dto);
    const onlyToggle =
      keys.length > 0 && keys.every((k) => k === 'isActive');

    // Snapshot the CURRENT state before a content-changing edit, so the full
    // version history is auditable. A pure activate/deactivate toggle does not
    // bump the version or snapshot.
    if (!onlyToggle) {
      await this.snapshotVersion(policy, userId, this.summariseChanges(policy, dto));
    }

    if (dto.policyName !== undefined) policy.policyName = dto.policyName.trim();
    if (dto.description !== undefined) policy.description = dto.description ?? null;
    if (dto.attachments !== undefined) policy.attachments = this.normAttachments(dto.attachments);
    if (dto.category !== undefined) policy.category = dto.category as PolicyEntity['category'];
    if (dto.workTiming !== undefined) policy.workTiming = dto.workTiming ?? null;
    if (dto.workLocation !== undefined) policy.workLocation = dto.workLocation ?? null;
    if (dto.wfhConfig !== undefined) policy.wfhConfig = dto.wfhConfig ?? null;
    if (dto.applicableTo !== undefined) policy.applicableTo = dto.applicableTo;
    if (dto.applicableIds !== undefined) policy.applicableIds = dto.applicableIds;
    if (dto.excludedEmployeeIds !== undefined) policy.excludedEmployeeIds = dto.excludedEmployeeIds;
    if (dto.effectiveFrom !== undefined)
      policy.effectiveFrom = dto.effectiveFrom ? new Date(dto.effectiveFrom) : null;
    if (dto.effectiveTo !== undefined)
      policy.effectiveTo = dto.effectiveTo ? new Date(dto.effectiveTo) : null;
    if (dto.acknowledgementRequired !== undefined)
      policy.acknowledgementRequired = dto.acknowledgementRequired;
    if (dto.isActive !== undefined) policy.isActive = dto.isActive;
    policy.updatedBy = userId;
    if (!onlyToggle) policy.version += 1;
    const saved = await this.repo.save(policy);
    // Announce only on an inactive → active transition (publish), not on every edit.
    if (!wasActive && saved.isActive) void this.notifyPublished(saved, userId);
    return saved;
  }

  /** Activate / deactivate without a version bump (the list toggle). */
  async setActive(orgId: string, id: string, isActive: boolean, userId: string) {
    const policy = await this.get(orgId, id);
    if (policy.isTemplate) throw new ForbiddenException('Templates cannot be toggled');
    const wasActive = policy.isActive;
    policy.isActive = isActive;
    policy.updatedBy = userId;
    const saved = await this.repo.save(policy);
    if (!wasActive && saved.isActive) void this.notifyPublished(saved, userId);
    return saved;
  }

  private async snapshotVersion(policy: PolicyEntity, userId: string, summary: string) {
    await this.versions.save(
      this.versions.create({
        policyId: policy.id,
        organizationId: policy.organizationId as string,
        version: policy.version,
        snapshot: JSON.parse(JSON.stringify(policy)),
        changedBy: userId,
        changeSummary: summary || null,
      }),
    );
  }

  /** Best-effort human summary of which fields the edit touches. */
  private summariseChanges(policy: PolicyEntity, dto: UpdatePolicyDto): string {
    const labels: Record<string, string> = {
      policyName: 'name',
      description: 'description',
      attachments: 'attachments',
      category: 'category',
      workTiming: 'work timing',
      workLocation: 'work location',
      wfhConfig: 'WFH rules',
      applicableTo: 'applicability',
      applicableIds: 'applicability',
      excludedEmployeeIds: 'exclusions',
      effectiveFrom: 'effective dates',
      effectiveTo: 'effective dates',
      acknowledgementRequired: 'acknowledgement',
    };
    const changed = new Set<string>();
    for (const k of Object.keys(dto)) {
      if (k === 'isActive') continue;
      if (labels[k]) changed.add(labels[k]);
    }
    return [...changed].join(', ');
  }

  async getVersionHistory(orgId: string, id: string) {
    await this.get(orgId, id); // org-scoped existence + isolation
    return this.versions.find({
      where: { organizationId: orgId, policyId: id },
      order: { version: 'DESC' },
    });
  }

  async remove(orgId: string, id: string): Promise<void> {
    const policy = await this.get(orgId, id);
    if (policy.isTemplate) throw new ForbiddenException('Templates cannot be deleted');
    policy.isDeleted = true;
    await this.repo.save(policy);
  }

  // ── templates ───────────────────────────────────────────────────────────────

  /** The static attendance-governing templates (not persisted; cloned on use). */
  listTemplates() {
    return POLICY_TEMPLATES.map((t, i) => ({ id: t.templateName, index: i, ...t }));
  }

  async createFromTemplate(
    orgId: string,
    templateName: string,
    dto: CreateFromTemplateDto,
    userId: string,
  ): Promise<PolicyEntity> {
    const tmpl = POLICY_TEMPLATES.find((t) => t.templateName === templateName);
    if (!tmpl) throw new NotFoundException('Template not found');
    const policy = this.repo.create({
      organizationId: orgId,
      policyName: (dto.policyName || tmpl.policyName).trim(),
      description: tmpl.description,
      category: tmpl.category,
      workTiming: tmpl.workTiming ?? null,
      workLocation: tmpl.workLocation ?? null,
      wfhConfig: tmpl.wfhConfig ?? null,
      applicableTo: dto.applicableTo ?? 'all',
      applicableIds: dto.applicableIds ?? [],
      excludedEmployeeIds: [],
      isTemplate: false,
      templateName: null,
      sourceTemplateId: null,
      // A location-tracking template defaults to requiring acknowledgement so
      // attached employees must consent; the caller can override either way.
      acknowledgementRequired:
        dto.acknowledgementRequired ?? tmpl.acknowledgementRequired ?? false,
      isActive: false, // draft until activated (like a normal create)
      version: 1,
      createdBy: userId,
      updatedBy: userId,
    });
    return this.repo.save(policy);
  }

  // ── acknowledgement ─────────────────────────────────────────────────────────

  async acknowledge(orgId: string, id: string, userId: string, version?: number) {
    const policy = await this.get(orgId, id); // org-scoped (fixes legacy leak)
    const v = version ?? policy.version;
    const existing = await this.acks.findOne({
      where: { policyId: id, employeeId: userId },
    });
    if (existing) {
      existing.version = v;
      existing.acknowledgedAt = new Date();
      existing.organizationId = orgId;
      return this.acks.save(existing);
    }
    return this.acks.save(
      this.acks.create({
        policyId: id,
        organizationId: orgId,
        employeeId: userId,
        version: v,
        acknowledgedAt: new Date(),
      }),
    );
  }

  async myAcknowledgements(orgId: string, userId: string) {
    return this.acks.find({ where: { organizationId: orgId, employeeId: userId } });
  }

  /**
   * The policies the caller MUST accept before using the platform: their
   * applicable, active policies flagged `acknowledgementRequired` that they have
   * not acknowledged at the current version (a version bump re-arms the gate).
   * Drives the login-time acceptance gate — empty list ⇒ access is unblocked.
   */
  async pendingAcknowledgements(orgId: string, userId: string): Promise<PolicyEntity[]> {
    const applicable = await this.listApplicable(orgId, userId);
    const required = applicable.filter((p) => p.acknowledgementRequired);
    if (required.length === 0) return [];
    const ackRows = await this.acks.find({
      where: { organizationId: orgId, employeeId: userId },
    });
    const ackByPolicy = new Map(ackRows.map((a) => [a.policyId, a]));
    return required.filter((p) => {
      const ack = ackByPolicy.get(p.id);
      return !ack || ack.version < p.version;
    });
  }

  // ── onboarding requirements config ──────────────────────────────────────────

  /** The full document catalog (grouped) + defaults, for the Settings UI. */
  onboardingCatalog() {
    return {
      documents: catalogByGroup(),
      checklist: ONBOARDING_CHECKLIST_CATALOG,
      profileFields: PROFILE_FIELD_CATALOG,
      defaults: defaultOnboardingConfig(),
    };
  }

  // ── leave configuration (owner-configurable, stored on a policy row) ────────

  /** The default leave-type list — the editor's starting point. */
  leaveCatalog() {
    return { defaults: defaultLeaveConfig().leaveTypes };
  }

  /** The org's leave policy row (category `leave`, applicableTo `all`) — a singleton. */
  private async findLeavePolicy(orgId: string): Promise<PolicyEntity | null> {
    return this.repo.findOne({
      where: {
        organizationId: orgId,
        category: 'leave',
        applicableTo: 'all',
        isDeleted: false,
      },
      order: { createdAt: 'ASC' },
    });
  }

  /** Resolve the org's leave types + allocations (saved config, else defaults). */
  async getLeaveConfig(orgId: string): Promise<LeaveConfig> {
    const policy = await this.findLeavePolicy(orgId);
    const stored = (policy?.extraConfig?.leave as { leaveTypes?: StoredLeaveType[] }) || null;
    return resolveLeaveConfig(stored?.leaveTypes);
  }

  /** Create-or-update the org's leave configuration. */
  async upsertLeaveConfig(
    orgId: string,
    leaveTypes: { key?: string; label?: string; annualAllocation?: number; enabled?: boolean }[],
    userId: string,
  ): Promise<LeaveConfig> {
    const stored = sanitizeLeaveConfig(leaveTypes);
    let policy = await this.findLeavePolicy(orgId);
    if (!policy) {
      policy = this.repo.create({
        organizationId: orgId,
        policyName: 'Leave Configuration',
        description: 'Which leave types the organization offers and their annual allocations.',
        category: 'leave',
        applicableTo: 'all',
        applicableIds: [],
        excludedEmployeeIds: [],
        isActive: true,
        acknowledgementRequired: false,
        createdBy: userId,
        updatedBy: userId,
      });
    }
    policy.extraConfig = { ...(policy.extraConfig || {}), leave: { leaveTypes: stored } };
    policy.updatedBy = userId;
    await this.repo.save(policy);
    return resolveLeaveConfig(stored);
  }

  // ── payroll statutory configuration (owner-configurable, on a policy row) ────

  /** The default statutory config + option lists — the Settings editor's start. */
  payrollConfigCatalog() {
    return {
      defaults: defaultPayrollConfig(),
      ptStates: ptStateOptions(),
      lwfStates: lwfStateOptions(),
      deductionBases: deductionBasisOptions(),
      templates: deductionTemplates(),
    };
  }

  /** The org's payroll policy row (category `payroll`, applicableTo `all`) — singleton. */
  private async findPayrollPolicy(orgId: string): Promise<PolicyEntity | null> {
    return this.repo.findOne({
      where: {
        organizationId: orgId,
        category: 'payroll',
        applicableTo: 'all',
        isDeleted: false,
      },
      order: { createdAt: 'ASC' },
    });
  }

  /** Resolve the org's statutory config (saved, else defaults). Never throws. */
  async getPayrollConfig(orgId: string): Promise<PayrollStatutoryConfig> {
    const policy = await this.findPayrollPolicy(orgId);
    const stored = (policy?.extraConfig?.payroll as Partial<PayrollStatutoryConfig>) || null;
    return resolvePayrollConfig(stored);
  }

  /**
   * Create-or-update the org's statutory config. This is a PARTIAL merge onto the
   * current config: only the fields present in `input` change (so, e.g., a PUT that
   * sends just `customDeductions` leaves PF/ESI/PT untouched). Since defaults are
   * opt-in (everything off), a full-replace here would silently disable deductions.
   */
  async upsertPayrollConfig(
    orgId: string,
    input: PayrollConfigInput,
    userId: string,
  ): Promise<PayrollStatutoryConfig> {
    const current = await this.getPayrollConfig(orgId);
    const merged: PayrollConfigInput = {
      pf: { ...current.pf, ...(input.pf || {}) },
      esi: { ...current.esi, ...(input.esi || {}) },
      ptState: input.ptState ?? current.ptState,
      lwf: { ...current.lwf, ...(input.lwf || {}) },
      customDeductions:
        input.customDeductions !== undefined ? input.customDeductions : current.customDeductions,
      lopFromAttendance:
        input.lopFromAttendance !== undefined ? input.lopFromAttendance : current.lopFromAttendance,
      tds: { ...current.tds, ...(input.tds || {}) },
      employer: { ...current.employer, ...(input.employer || {}) },
    };
    const clean = sanitizePayrollConfig(merged);
    let policy = await this.findPayrollPolicy(orgId);
    if (!policy) {
      policy = this.repo.create({
        organizationId: orgId,
        policyName: 'Payroll Configuration',
        description: 'Statutory deduction rules (PF, ESI, Professional Tax) applied when running payroll.',
        category: 'payroll',
        applicableTo: 'all',
        applicableIds: [],
        excludedEmployeeIds: [],
        isActive: true,
        acknowledgementRequired: false,
        createdBy: userId,
        updatedBy: userId,
      });
    }
    policy.extraConfig = { ...(policy.extraConfig || {}), payroll: clean };
    policy.updatedBy = userId;
    await this.repo.save(policy);
    return clean;
  }

  // ── timesheet config ──────────────────────────────────────────────────────────

  private async findTimesheetPolicy(orgId: string): Promise<PolicyEntity | null> {
    return this.repo.findOne({
      where: { organizationId: orgId, category: 'timesheet', applicableTo: 'all', isDeleted: false },
      order: { createdAt: 'ASC' },
    });
  }

  async getTimesheetConfig(orgId: string): Promise<TimesheetConfig> {
    const policy = await this.findTimesheetPolicy(orgId);
    return resolveTimesheetConfig((policy?.extraConfig?.timesheet as TimesheetConfigInput) || null);
  }

  async upsertTimesheetConfig(orgId: string, input: TimesheetConfigInput, userId: string): Promise<TimesheetConfig> {
    const current = await this.getTimesheetConfig(orgId);
    const clean = sanitizeTimesheetConfig({
      enabled: input.enabled ?? current.enabled,
      cadence: input.cadence ?? current.cadence,
      allowEdits: input.allowEdits ?? current.allowEdits,
    });
    let policy = await this.findTimesheetPolicy(orgId);
    if (!policy) {
      policy = this.repo.create({
        organizationId: orgId,
        policyName: 'Timesheet Policy',
        description: 'How often employees submit timesheets (weekly or monthly).',
        category: 'timesheet',
        applicableTo: 'all',
        applicableIds: [],
        excludedEmployeeIds: [],
        isActive: true,
        acknowledgementRequired: false,
        createdBy: userId,
        updatedBy: userId,
      });
    }
    policy.extraConfig = { ...(policy.extraConfig || {}), timesheet: clean };
    policy.updatedBy = userId;
    await this.repo.save(policy);
    return clean;
  }

  /**
   * The org's onboarding policy row (category `onboarding`, applicableTo `all`) —
   * a singleton per org that carries the requirements config in `extraConfig`.
   * Not auto-seeded: `getOnboardingConfig` falls back to catalog defaults so an
   * org that never opens Settings still onboards sensibly.
   */
  private async findOnboardingPolicy(orgId: string): Promise<PolicyEntity | null> {
    return this.repo.findOne({
      where: {
        organizationId: orgId,
        category: 'onboarding',
        applicableTo: 'all',
        isDeleted: false,
      },
      order: { createdAt: 'ASC' },
    });
  }

  /** Resolve the org's live onboarding requirements (saved config, else defaults). */
  async getOnboardingConfig(orgId: string): Promise<OnboardingConfig> {
    const policy = await this.findOnboardingPolicy(orgId);
    const stored = (policy?.extraConfig?.onboarding as OnboardingConfig) || null;
    if (!stored) return defaultOnboardingConfig();
    const fallback = defaultOnboardingConfig();
    // Refresh doc titles from the catalog (a custom doc keeps its own title).
    const titleByKey = new Map(ONBOARDING_DOCUMENT_CATALOG.map((d) => [d.key, d.title]));
    return {
      documents: (stored.documents || []).map((d) => ({
        key: d.key,
        title: titleByKey.get(d.key) || d.title,
        required: !!d.required,
      })),
      checklist: stored.checklist
        ? sanitizeChecklist(stored.checklist)
        : fallback.checklist,
      defaultProbationMonths:
        typeof stored.defaultProbationMonths === 'number'
          ? stored.defaultProbationMonths
          : fallback.defaultProbationMonths,
      targetDays:
        typeof stored.targetDays === 'number' ? stored.targetDays : fallback.targetDays,
      profileFields: stored.profileFields
        ? sanitizeProfileFields(stored.profileFields)
        : fallback.profileFields,
    };
  }

  /** Create-or-update the org's onboarding requirements config. */
  async upsertOnboardingConfig(
    orgId: string,
    dto: UpdateOnboardingConfigDto,
    userId: string,
  ): Promise<OnboardingConfig> {
    const current = await this.getOnboardingConfig(orgId);
    const titleByKey = new Map(ONBOARDING_DOCUMENT_CATALOG.map((d) => [d.key, d.title]));
    const next: OnboardingConfig = {
      documents: (dto.documents ?? current.documents).map((d) => ({
        key: d.key,
        title: titleByKey.get(d.key) || d.title,
        required: !!d.required,
      })),
      checklist: sanitizeChecklist(dto.checklist ?? current.checklist),
      defaultProbationMonths:
        dto.defaultProbationMonths ?? current.defaultProbationMonths,
      targetDays: dto.targetDays ?? current.targetDays,
      profileFields: dto.profileFields
        ? sanitizeProfileFields(dto.profileFields)
        : current.profileFields,
    };

    let policy = await this.findOnboardingPolicy(orgId);
    if (!policy) {
      policy = this.repo.create({
        organizationId: orgId,
        policyName: 'Onboarding Requirements',
        description: 'What every new hire must submit and complete to finish onboarding.',
        category: 'onboarding',
        applicableTo: 'all',
        applicableIds: [],
        excludedEmployeeIds: [],
        isActive: true,
        acknowledgementRequired: false,
        createdBy: userId,
        updatedBy: userId,
      });
    }
    policy.extraConfig = { ...(policy.extraConfig || {}), onboarding: next };
    policy.updatedBy = userId;
    await this.repo.save(policy);
    return next;
  }

  private normAttachments(list?: { fileId: string; name: string; mimeType: string; size: number; uploadedAt?: string }[]) {
    if (!list) return null;
    return list.map((a) => ({
      fileId: a.fileId,
      name: a.name,
      mimeType: a.mimeType,
      size: a.size,
      uploadedAt: a.uploadedAt || new Date().toISOString(),
    }));
  }

  /**
   * Who must acknowledge this policy and who has (owner/manager compliance view).
   * A member "must acknowledge" if the policy applies to them; they're compliant
   * only if they acknowledged the CURRENT version (a version bump re-arms it).
   */
  async getAcknowledgementStatus(orgId: string, id: string) {
    const policy = await this.get(orgId, id);
    const members = await this.memberships.find({
      where: { organizationId: orgId, status: 'active' },
    });
    const applicable = members.filter(
      (m) =>
        m.userId &&
        !isPolicyExemptRole(m.role) && // the owner is never a policy subject
        matchesApplicability(policy, {
          _id: m.userId,
          departmentId: m.departmentId,
          designationId: m.roleId,
        }) &&
        !(policy.excludedEmployeeIds || []).map(String).includes(m.userId),
    );
    const ackRows = await this.acks.find({ where: { organizationId: orgId, policyId: id } });
    const ackByUser = new Map(ackRows.map((a) => [a.employeeId, a]));
    const ids = applicable.map((m) => m.userId as string);
    const users = ids.length ? await this.users.find({ where: { id: In(ids) } }) : [];
    const nameById = new Map(
      users.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim() || u.email]),
    );
    const emailById = new Map(users.map((u) => [u.id, u.email]));
    const rows = applicable.map((m) => {
      const ack = ackByUser.get(m.userId as string);
      const acknowledged = !!ack && ack.version >= policy.version;
      return {
        userId: m.userId,
        name: nameById.get(m.userId as string) || m.email || 'Member',
        email: emailById.get(m.userId as string) || m.email || null,
        acknowledged,
        acknowledgedAt: ack?.acknowledgedAt ?? null,
        ackedVersion: ack?.version ?? null,
        needsReAck: !!ack && ack.version < policy.version,
      };
    });
    const acked = rows.filter((r) => r.acknowledged);
    const pending = rows.filter((r) => !r.acknowledged);
    return {
      policyId: id,
      policyName: policy.policyName,
      version: policy.version,
      total: rows.length,
      ackedCount: acked.length,
      pendingCount: pending.length,
      acked,
      pending,
    };
  }

  /** Dashboard summary for owners: policy counts + outstanding acknowledgements. */
  async getOwnerSummary(orgId: string) {
    const all = await this.list(orgId);
    const active = all.filter((p) => p.isActive);
    const drafts = all.filter((p) => !p.isActive);
    // "Custom" = anything the owner authored beyond the single seeded default.
    const hasCustom = all.some(
      (p) => !(p.applicableTo === 'all' && p.category === 'working_hours' && p.createdBy && p.policyName === 'Standard Work Timing'),
    );
    let pendingAcks = 0;
    for (const p of active.filter((p) => p.acknowledgementRequired)) {
      const status = await this.getAcknowledgementStatus(orgId, p.id);
      pendingAcks += status.pendingCount;
    }
    return {
      total: all.length,
      active: active.length,
      drafts: drafts.length,
      hasCustomPolicy: hasCustom,
      pendingAcknowledgements: pendingAcks,
    };
  }

  // ── acknowledgement compliance (owner/manager) ─────────────────────────────

  /**
   * Org-wide acknowledgement compliance across every active, acknowledgement-
   * required policy: overall coverage, a per-policy breakdown, and the list of
   * people who still owe an acknowledgement (with WHICH policies they owe). An
   * "assignment" is one (applicable member × policy) pair. The owner is never a
   * policy subject, so they never appear here.
   */
  async complianceOverview(orgId: string) {
    const all = await this.list(orgId);
    const tracked = all.filter((p) => p.isActive && p.acknowledgementRequired);

    const perPolicy: {
      policyId: string;
      policyName: string;
      category: string;
      version: number;
      total: number;
      ackedCount: number;
      pendingCount: number;
      coveragePct: number;
    }[] = [];

    // userId → their outstanding policies
    const outstanding = new Map<
      string,
      {
        userId: string;
        name: string;
        email: string | null;
        pending: { policyId: string; policyName: string; needsReAck: boolean }[];
      }
    >();

    let totalAssignments = 0;
    let ackedAssignments = 0;

    for (const p of tracked) {
      const s = await this.getAcknowledgementStatus(orgId, p.id);
      totalAssignments += s.total;
      ackedAssignments += s.ackedCount;
      perPolicy.push({
        policyId: p.id,
        policyName: p.policyName,
        category: p.category,
        version: p.version,
        total: s.total,
        ackedCount: s.ackedCount,
        pendingCount: s.pendingCount,
        coveragePct: s.total ? Math.round((s.ackedCount / s.total) * 100) : 100,
      });
      for (const r of s.pending) {
        if (!r.userId) continue;
        const entry =
          outstanding.get(r.userId) ??
          { userId: r.userId, name: r.name, email: r.email ?? null, pending: [] };
        entry.pending.push({ policyId: p.id, policyName: p.policyName, needsReAck: r.needsReAck });
        outstanding.set(r.userId, entry);
      }
    }

    const people = [...outstanding.values()].sort(
      (a, b) => b.pending.length - a.pending.length || a.name.localeCompare(b.name),
    );

    return {
      coveragePct: totalAssignments ? Math.round((ackedAssignments / totalAssignments) * 100) : 100,
      policiesTracked: tracked.length,
      totalAssignments,
      ackedAssignments,
      outstandingAssignments: totalAssignments - ackedAssignments,
      outstandingPeople: people.length,
      perPolicy,
      people,
    };
  }

  /**
   * Nudge everyone still pending on ONE policy with an in-app reminder that routes
   * to the policies page. Respects each recipient's notification preferences.
   */
  async remindPendingAck(
    orgId: string,
    policyId: string,
    actorId: string,
  ): Promise<{ reminded: number; policyName: string }> {
    const s = await this.getAcknowledgementStatus(orgId, policyId);
    let reminded = 0;
    for (const r of s.pending) {
      if (!r.userId) continue;
      await this.notifier.notify({
        organizationId: orgId,
        userId: r.userId,
        actorId,
        type: 'policy_ack_reminder',
        title: 'Policy acknowledgement needed',
        body: `Please review and acknowledge "${s.policyName}".`,
        data: { actionUrl: '/policies', policyId },
        priority: 'high',
      });
      reminded++;
    }
    return { reminded, policyName: s.policyName };
  }

  /**
   * Nudge every outstanding person across all tracked policies — ONE reminder per
   * person, summarising how many acknowledgements they owe (not one per policy).
   */
  async remindAllOutstanding(
    orgId: string,
    actorId: string,
  ): Promise<{ reminded: number }> {
    const overview = await this.complianceOverview(orgId);
    let reminded = 0;
    for (const person of overview.people) {
      const n = person.pending.length;
      await this.notifier.notify({
        organizationId: orgId,
        userId: person.userId,
        actorId,
        type: 'policy_ack_reminder',
        title: n === 1 ? 'Policy acknowledgement needed' : 'Policy acknowledgements needed',
        body:
          n === 1
            ? `Please review and acknowledge "${person.pending[0].policyName}".`
            : `You have ${n} policies waiting for your acknowledgement.`,
        data: { actionUrl: '/policies' },
        priority: 'high',
      });
      reminded++;
    }
    return { reminded };
  }

  // ── the resolver attendance consumes ───────────────────────────────────────

  /**
   * Build the applicability scope for an employee from their org membership, and
   * flag whether they're exempt from policies (the owner). One membership read
   * serves both.
   */
  private async scopeFor(
    orgId: string,
    userId: string,
  ): Promise<{ scope: EmployeeScope; exempt: boolean }> {
    const m = await this.memberships.findOne({
      where: { organizationId: orgId, userId },
    });
    return {
      scope: {
        _id: userId, // Nexora: 'specific' applicability targets the userId
        departmentId: m?.departmentId ?? null,
        designationId: m?.roleId ?? null, // Nexora: Role stands in for Designation
      },
      exempt: isPolicyExemptRole(m?.role),
    };
  }

  /**
   * Resolve the single work-timing policy governing this employee's clock-in.
   * Precedence: specific ▸ department/designation ▸ org-wide (all), among active,
   * non-deleted, non-template, in-effect timing policies, minus exclusions. Nexora
   * has no per-employee attach tier — 'specific' (by userId) covers it.
   */
  async resolveForEmployee(orgId: string, userId: string): Promise<ResolvedWorkContext> {
    const now = new Date();
    const { scope, exempt } = await this.scopeFor(orgId, userId);
    // The owner is not governed by the org's work-timing policies.
    if (exempt) {
      return { policyId: null, policyName: null, workTiming: null, workLocation: null, wfhConfig: null };
    }

    const all = await this.repo.find({
      where: { organizationId: orgId, isDeleted: false, isActive: true, isTemplate: false },
    });
    const candidates = all.filter(
      (p) =>
        TIMING_CATEGORIES.includes(p.category) &&
        p.workTiming?.startTime &&
        isPolicyEffective(p, now) &&
        !(p.excludedEmployeeIds || []).map(String).includes(userId),
    );

    const pick = (pred: (p: PolicyEntity) => boolean): PolicyEntity | null => {
      const tier = candidates.filter(pred).sort(byUpdatedAtDesc);
      return tier[0] || null;
    };

    const winner =
      pick((p) => p.applicableTo === 'specific' && matchesApplicability(p, scope)) ||
      pick(
        (p) =>
          (p.applicableTo === 'department' || p.applicableTo === 'designation') &&
          matchesApplicability(p, scope),
      ) ||
      pick((p) => p.applicableTo === 'all');

    if (!winner) {
      return { policyId: null, policyName: null, workTiming: null, workLocation: null, wfhConfig: null };
    }
    return {
      policyId: winner.id,
      policyName: winner.policyName,
      workTiming: winner.workTiming,
      workLocation: winner.workLocation,
      wfhConfig: winner.wfhConfig,
    };
  }

  /** Employee-facing: the policies that apply to them (for the read/ack list). */
  async listApplicable(orgId: string, userId: string): Promise<PolicyEntity[]> {
    const { scope, exempt } = await this.scopeFor(orgId, userId);
    // The owner is not a subject of the org's policies (no ack gate, no applies-to).
    if (exempt) return [];
    const all = await this.repo.find({
      where: { organizationId: orgId, isDeleted: false, isActive: true, isTemplate: false },
      order: { createdAt: 'DESC' },
    });
    return all.filter(
      (p) =>
        matchesApplicability(p, scope) &&
        !(p.excludedEmployeeIds || []).map(String).includes(userId),
    );
  }
}
