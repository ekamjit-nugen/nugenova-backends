import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

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
import { isPolicyEffective, matchesApplicability, EmployeeScope } from './util/policy-eligibility';
import { DEFAULT_ORG_WORK_TIMING, POLICY_TEMPLATES } from './default-policies';
import {
  CreatePolicyDto,
  UpdatePolicyDto,
  PolicyQueryDto,
  CreateFromTemplateDto,
} from './dto';

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
  ) {}

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
    return this.repo.save(policy);
  }

  async list(orgId: string, q: PolicyQueryDto = {}): Promise<PolicyEntity[]> {
    const where: any = { organizationId: orgId, isDeleted: false };
    if (q.category) where.category = q.category;
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
    return this.repo.save(policy);
  }

  /** Activate / deactivate without a version bump (the list toggle). */
  async setActive(orgId: string, id: string, isActive: boolean, userId: string) {
    const policy = await this.get(orgId, id);
    if (policy.isTemplate) throw new ForbiddenException('Templates cannot be toggled');
    policy.isActive = isActive;
    policy.updatedBy = userId;
    return this.repo.save(policy);
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
    const rows = applicable.map((m) => {
      const ack = ackByUser.get(m.userId as string);
      const acknowledged = !!ack && ack.version >= policy.version;
      return {
        userId: m.userId,
        name: nameById.get(m.userId as string) || m.email || 'Member',
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

  // ── the resolver attendance consumes ───────────────────────────────────────

  /** Build the applicability scope for an employee from their org membership. */
  private async employeeScope(orgId: string, userId: string): Promise<EmployeeScope> {
    const m = await this.memberships.findOne({
      where: { organizationId: orgId, userId },
    });
    return {
      _id: userId, // Nexora: 'specific' applicability targets the userId
      departmentId: m?.departmentId ?? null,
      designationId: m?.roleId ?? null, // Nexora: Role stands in for Designation
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
    const scope = await this.employeeScope(orgId, userId);

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
    const scope = await this.employeeScope(orgId, userId);
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
