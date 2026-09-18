import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { UserEntity } from '../../auth/entities/user.entity';
import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';
import { NotifierService } from '../../notification/notifier.service';
import { ActivityService } from '../../activity/activity.service';
import { DomainEventsService } from '../../platform-events/domain-events.service';
import { DOMAIN_EVENTS } from '../../platform-events/domain-events';
import {
  ApplicationStageEventEntity, CandidateActivityEntity, CandidateApplicationEntity, CandidateEntity,
  RecruitmentOpeningEntity, RecruitmentSettingsEntity, RecruitmentStageEntity, ScorecardTemplateEntity,
} from '../entities';
import {
  CandidateActivityType, DEFAULT_REJECTION_REASONS, DEFAULT_SCORECARD_CRITERIA, DEFAULT_STAGES, RECRUITMENT_NOTIFICATIONS,
} from '../recruitment.constants';
import {
  BulkMoveDto, CreateApplicationDto, CreateStageDto, MoveApplicationDto, ReorderStagesDto, ScorecardTemplateDto,
  UpdateApplicationDto, UpdateSettingsDto, UpdateStageDto,
} from '../dto';
import { RecruitmentCaller, nameOf } from './recruitment-caller';

/**
 * Pipeline core shared by every other recruitment service: stages, settings,
 * scorecard templates, applications (create / move / withdraw) with their
 * append-only stage-event trail, and the candidate timeline + notifications.
 */
@Injectable()
export class PipelineService {
  private readonly logger = new Logger(PipelineService.name);

  constructor(
    @InjectRepository(RecruitmentStageEntity) private readonly stages: Repository<RecruitmentStageEntity>,
    @InjectRepository(RecruitmentSettingsEntity) private readonly settings: Repository<RecruitmentSettingsEntity>,
    @InjectRepository(ScorecardTemplateEntity) private readonly scorecards: Repository<ScorecardTemplateEntity>,
    @InjectRepository(CandidateApplicationEntity) private readonly applications: Repository<CandidateApplicationEntity>,
    @InjectRepository(ApplicationStageEventEntity) private readonly events: Repository<ApplicationStageEventEntity>,
    @InjectRepository(CandidateActivityEntity) private readonly activities: Repository<CandidateActivityEntity>,
    @InjectRepository(CandidateEntity) private readonly candidates: Repository<CandidateEntity>,
    @InjectRepository(RecruitmentOpeningEntity) private readonly openings: Repository<RecruitmentOpeningEntity>,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(OrgMembershipEntity) private readonly memberships: Repository<OrgMembershipEntity>,
    private readonly activityFeed: ActivityService,
    @Optional() private readonly notifier?: NotifierService,
    @Optional() private readonly domainEvents?: DomainEventsService,
  ) {}

  // ── stages ─────────────────────────────────────────────────────────────────────

  /** Seed the default funnel the first time an org touches recruitment. */
  async ensureStages(orgId: string): Promise<RecruitmentStageEntity[]> {
    const existing = await this.stages.find({ where: { organizationId: orgId, isDeleted: false }, order: { order: 'ASC' } });
    if (existing.length) return existing;
    await this.stages.save(DEFAULT_STAGES.map((s) => this.stages.create({ organizationId: orgId, ...s, isDeleted: false })));
    return this.stages.find({ where: { organizationId: orgId, isDeleted: false }, order: { order: 'ASC' } });
  }

  async requireStage(orgId: string, id: string): Promise<RecruitmentStageEntity> {
    const s = await this.stages.findOne({ where: { id, organizationId: orgId, isDeleted: false } });
    if (!s) throw new BadRequestException('Stage not found');
    return s;
  }

  async defaultStage(orgId: string): Promise<RecruitmentStageEntity> {
    const all = await this.ensureStages(orgId);
    return all.find((s) => s.isDefault) ?? all.find((s) => s.kind === 'active') ?? all[0];
  }

  async createStage(caller: RecruitmentCaller, dto: CreateStageDto) {
    const all = await this.ensureStages(caller.orgId);
    if (all.some((s) => s.name.toLowerCase() === dto.name.trim().toLowerCase())) throw new ConflictException('A stage with that name already exists');
    // Insert before the closing (hired/rejected) stages unless an order is given.
    const firstClosed = all.find((s) => s.kind !== 'active');
    const kind = (dto.kind ?? 'active') as RecruitmentStageEntity['kind'];
    const order = dto.order ?? (kind === 'active' && firstClosed ? firstClosed.order : Math.max(0, ...all.map((s) => s.order)) + 1);
    for (const s of all.filter((x) => x.order >= order)) s.order += 1;
    await this.stages.save(all);
    return this.stages.save(this.stages.create({
      organizationId: caller.orgId, name: dto.name.trim(), order, kind, color: dto.color ?? null, isDefault: false, isDeleted: false,
    }));
  }

  async updateStage(caller: RecruitmentCaller, id: string, dto: UpdateStageDto) {
    const all = await this.ensureStages(caller.orgId);
    const stage = all.find((s) => s.id === id);
    if (!stage) throw new NotFoundException('Stage not found');
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (all.some((s) => s.id !== id && s.name.toLowerCase() === name.toLowerCase())) throw new ConflictException('A stage with that name already exists');
      stage.name = name;
    }
    if (dto.color !== undefined) stage.color = dto.color || null;
    if (dto.kind !== undefined && dto.kind !== stage.kind) {
      const remaining = all.filter((s) => s.id !== id && s.kind === stage.kind);
      if (stage.kind !== 'active' && !remaining.length) throw new BadRequestException(`The pipeline needs at least one "${stage.kind}" stage`);
      stage.kind = dto.kind as RecruitmentStageEntity['kind'];
      if (stage.kind !== 'active') stage.isDefault = false;
    }
    if (dto.isDefault === true) {
      if (stage.kind !== 'active') throw new BadRequestException('Only an in-progress stage can be the default');
      for (const s of all) s.isDefault = s.id === id;
      await this.stages.save(all);
    }
    return this.stages.save(stage);
  }

  async reorderStages(caller: RecruitmentCaller, dto: ReorderStagesDto) {
    const all = await this.ensureStages(caller.orgId);
    const byId = new Map(all.map((s) => [s.id, s]));
    if (dto.ids.length !== all.length || !dto.ids.every((id) => byId.has(id))) {
      throw new BadRequestException('Provide every stage id exactly once');
    }
    dto.ids.forEach((id, i) => { byId.get(id)!.order = i + 1; });
    await this.stages.save(all);
    return this.ensureStages(caller.orgId);
  }

  async deleteStage(caller: RecruitmentCaller, id: string) {
    const all = await this.ensureStages(caller.orgId);
    const stage = all.find((s) => s.id === id);
    if (!stage) throw new NotFoundException('Stage not found');
    if (stage.kind !== 'active' && all.filter((s) => s.kind === stage.kind).length <= 1) {
      throw new BadRequestException(`The pipeline needs at least one "${stage.kind}" stage`);
    }
    if (all.filter((s) => s.kind === 'active').length <= 1 && stage.kind === 'active') {
      throw new BadRequestException('The pipeline needs at least one in-progress stage');
    }
    const inUse = await this.applications.count({ where: { organizationId: caller.orgId, stageId: id, isDeleted: false } });
    if (inUse) throw new BadRequestException(`Move the ${inUse} candidate(s) out of "${stage.name}" before deleting it`);
    stage.isDeleted = true;
    await this.stages.save(stage);
    if (stage.isDefault) {
      const next = all.find((s) => s.id !== id && s.kind === 'active');
      if (next) { next.isDefault = true; await this.stages.save(next); }
    }
    return { success: true as const };
  }

  // ── settings + scorecards ──────────────────────────────────────────────────────

  async getSettings(orgId: string): Promise<RecruitmentSettingsEntity> {
    const existing = await this.settings.findOne({ where: { organizationId: orgId } });
    if (existing) return existing;
    try {
      return await this.settings.save(this.settings.create({
        organizationId: orgId, rejectionReasons: [...DEFAULT_REJECTION_REASONS], tags: [], feedbackReminderHours: 2,
      }));
    } catch {
      // Concurrent first read — the unique index won; read the winner.
      return (await this.settings.findOne({ where: { organizationId: orgId } }))!;
    }
  }

  async updateSettings(caller: RecruitmentCaller, dto: UpdateSettingsDto) {
    const s = await this.getSettings(caller.orgId);
    const clean = (arr: string[]) => [...new Set(arr.map((x) => x.trim()).filter(Boolean))];
    if (dto.rejectionReasons !== undefined) s.rejectionReasons = clean(dto.rejectionReasons);
    if (dto.tags !== undefined) s.tags = clean(dto.tags);
    if (dto.feedbackReminderHours !== undefined) s.feedbackReminderHours = dto.feedbackReminderHours;
    return this.settings.save(s);
  }

  async listScorecards(orgId: string) {
    const rows = await this.scorecards.find({ where: { organizationId: orgId, isDeleted: false }, order: { createdAt: 'ASC' } });
    if (rows.length) return rows;
    await this.scorecards.save(this.scorecards.create({
      organizationId: orgId, name: 'Standard interview', criteria: [...DEFAULT_SCORECARD_CRITERIA], isDefault: true, isDeleted: false,
    }));
    return this.scorecards.find({ where: { organizationId: orgId, isDeleted: false }, order: { createdAt: 'ASC' } });
  }

  async scorecardCriteria(orgId: string, templateId?: string | null): Promise<string[]> {
    const all = await this.listScorecards(orgId);
    const t = (templateId && all.find((s) => s.id === templateId)) || all.find((s) => s.isDefault) || all[0];
    return t?.criteria?.length ? t.criteria : [...DEFAULT_SCORECARD_CRITERIA];
  }

  async saveScorecard(caller: RecruitmentCaller, dto: ScorecardTemplateDto, id?: string) {
    const all = await this.listScorecards(caller.orgId);
    const criteria = [...new Set(dto.criteria.map((c) => c.trim()).filter(Boolean))];
    if (!criteria.length) throw new BadRequestException('Add at least one criterion');
    let row: ScorecardTemplateEntity;
    if (id) {
      const found = all.find((s) => s.id === id);
      if (!found) throw new NotFoundException('Scorecard not found');
      row = found;
      row.name = dto.name.trim();
      row.criteria = criteria;
    } else {
      row = this.scorecards.create({ organizationId: caller.orgId, name: dto.name.trim(), criteria, isDefault: false, createdBy: caller.userId, isDeleted: false });
    }
    if (dto.isDefault) {
      for (const s of all) if (s.id !== row.id && s.isDefault) { s.isDefault = false; await this.scorecards.save(s); }
      row.isDefault = true;
    }
    return this.scorecards.save(row);
  }

  async deleteScorecard(caller: RecruitmentCaller, id: string) {
    const all = await this.listScorecards(caller.orgId);
    const row = all.find((s) => s.id === id);
    if (!row) throw new NotFoundException('Scorecard not found');
    if (all.length <= 1) throw new BadRequestException('Keep at least one scorecard template');
    row.isDeleted = true;
    await this.scorecards.save(row);
    if (row.isDefault) {
      const next = all.find((s) => s.id !== id)!;
      next.isDefault = true;
      await this.scorecards.save(next);
    }
    return { success: true as const };
  }

  // ── applications ───────────────────────────────────────────────────────────────

  async requireApplication(orgId: string, id: string): Promise<CandidateApplicationEntity> {
    const a = await this.applications.findOne({ where: { id, organizationId: orgId, isDeleted: false } });
    if (!a) throw new NotFoundException('Application not found');
    return a;
  }

  async requireCandidate(orgId: string, id: string): Promise<CandidateEntity> {
    const c = await this.candidates.findOne({ where: { id, organizationId: orgId, isDeleted: false } });
    if (!c) throw new NotFoundException('Candidate not found');
    return c;
  }

  async requireOpening(orgId: string, id: string): Promise<RecruitmentOpeningEntity> {
    const o = await this.openings.findOne({ where: { id, organizationId: orgId, isDeleted: false } });
    if (!o) throw new NotFoundException('Category not found');
    return o;
  }

  async createApplication(caller: RecruitmentCaller, dto: CreateApplicationDto, opts: { note?: string } = {}) {
    const [candidate, opening] = await Promise.all([
      this.requireCandidate(caller.orgId, dto.candidateId),
      this.requireOpening(caller.orgId, dto.openingId),
    ]);
    const existing = await this.applications.findOne({
      where: { organizationId: caller.orgId, candidateId: candidate.id, openingId: opening.id, isDeleted: false },
    });
    if (existing) throw new ConflictException(`${candidate.fullName} is already in the pipeline for "${opening.title}"`);
    if (dto.ownerId) await this.assertMembers(caller.orgId, [dto.ownerId]);

    const stage = dto.stageId ? await this.requireStage(caller.orgId, dto.stageId) : await this.defaultStage(caller.orgId);
    const now = new Date();
    const app = await this.applications.save(this.applications.create({
      organizationId: caller.orgId, candidateId: candidate.id, openingId: opening.id, stageId: stage.id,
      status: stage.kind === 'active' ? 'active' : stage.kind,
      appliedAt: now, stageChangedAt: now,
      hiredAt: stage.kind === 'hired' ? now : null, rejectedAt: stage.kind === 'rejected' ? now : null,
      ownerId: dto.ownerId ?? candidate.ownerId ?? caller.userId, createdBy: caller.userId, isDeleted: false,
    }));
    await this.events.save(this.events.create({
      organizationId: caller.orgId, applicationId: app.id, fromStageId: null, toStageId: stage.id, byUserId: caller.userId, note: opts.note ?? null, at: now,
    }));
    await this.logActivity(caller.orgId, candidate.id, 'stage_change', `Added to "${opening.title}" at ${stage.name}`, {
      applicationId: app.id, actorId: caller.userId, meta: { openingId: opening.id, toStageId: stage.id },
    });
    return app;
  }

  async moveApplication(caller: RecruitmentCaller, id: string, dto: MoveApplicationDto) {
    const app = await this.requireApplication(caller.orgId, id);
    const stage = await this.requireStage(caller.orgId, dto.stageId);
    if (stage.id === app.stageId && !dto.note) return app;
    if (stage.kind === 'rejected' && !dto.rejectionReason?.trim() && app.stageId !== stage.id) {
      throw new BadRequestException('A rejection reason is required');
    }
    const from = app.stageId;
    const now = new Date();
    app.stageId = stage.id;
    app.stageChangedAt = from !== stage.id ? now : app.stageChangedAt;
    app.status = stage.kind === 'active' ? 'active' : stage.kind;
    app.hiredAt = stage.kind === 'hired' ? (app.hiredAt ?? now) : null;
    app.rejectedAt = stage.kind === 'rejected' ? (app.rejectedAt ?? now) : null;
    app.rejectionReason = stage.kind === 'rejected' ? (dto.rejectionReason?.trim() || app.rejectionReason) : null;
    const saved = await this.applications.save(app);

    await this.events.save(this.events.create({
      organizationId: caller.orgId, applicationId: app.id, fromStageId: from, toStageId: stage.id, byUserId: caller.userId,
      note: [dto.rejectionReason && stage.kind === 'rejected' ? `Reason: ${dto.rejectionReason}` : null, dto.note].filter(Boolean).join(' — ') || null,
      at: now,
    }));

    const [opening, candidate] = await Promise.all([
      this.openings.findOne({ where: { id: app.openingId } }),
      this.candidates.findOne({ where: { id: app.candidateId } }),
    ]);
    const body = [
      `Moved to ${stage.name}${opening ? ` for "${opening.title}"` : ''}`,
      stage.kind === 'rejected' && app.rejectionReason ? `Reason: ${app.rejectionReason}` : null,
      dto.note?.trim() || null,
    ].filter(Boolean).join('\n');
    await this.logActivity(caller.orgId, app.candidateId, 'stage_change', body, {
      applicationId: app.id, actorId: caller.userId, meta: { fromStageId: from, toStageId: stage.id, openingId: app.openingId },
    });

    this.domainEvents?.emit(DOMAIN_EVENTS.APPLICATION_STAGE_CHANGED, {
      organizationId: caller.orgId, actorId: caller.userId, applicationId: app.id, candidateId: app.candidateId,
      openingId: app.openingId, fromStageId: from, toStageId: stage.id,
    });

    if (stage.kind === 'hired' && from !== stage.id) {
      this.domainEvents?.emit(DOMAIN_EVENTS.CANDIDATE_HIRED, {
        organizationId: caller.orgId, actorId: caller.userId, applicationId: app.id, candidateId: app.candidateId, openingId: app.openingId,
      });
      await this.markOpeningFilledIfDone(caller.orgId, app.openingId);
    }

    if (candidate && opening) {
      const recipients = new Set([app.ownerId, candidate.ownerId, opening.hiringManagerId].filter((x): x is string => !!x && x !== caller.userId));
      for (const userId of recipients) {
        this.notify({
          organizationId: caller.orgId, userId, actorId: caller.userId, type: RECRUITMENT_NOTIFICATIONS.STAGE_CHANGED,
          title: `${candidate.fullName} moved to ${stage.name}`, body: opening.title,
          data: { actionUrl: `/recruitment/candidates/${candidate.id}`, candidateId: candidate.id, applicationId: app.id },
        });
      }
    }
    return saved;
  }

  async bulkMove(caller: RecruitmentCaller, dto: BulkMoveDto) {
    const results: { id: string; ok: boolean; error?: string }[] = [];
    for (const id of [...new Set(dto.applicationIds)]) {
      try {
        await this.moveApplication(caller, id, dto);
        results.push({ id, ok: true });
      } catch (err) {
        results.push({ id, ok: false, error: (err as Error).message });
      }
    }
    return { moved: results.filter((r) => r.ok).length, results };
  }

  async updateApplication(caller: RecruitmentCaller, id: string, dto: UpdateApplicationDto) {
    const app = await this.requireApplication(caller.orgId, id);
    if (dto.ownerId !== undefined) {
      if (dto.ownerId) await this.assertMembers(caller.orgId, [dto.ownerId]);
      app.ownerId = dto.ownerId || null;
    }
    if (dto.status !== undefined && dto.status !== app.status) {
      if (dto.status === 'withdrawn') {
        app.status = 'withdrawn';
        await this.logActivity(caller.orgId, app.candidateId, 'system', 'Application withdrawn', { applicationId: app.id, actorId: caller.userId });
      } else if (dto.status === 'active' && app.status === 'withdrawn') {
        const stage = await this.requireStage(caller.orgId, app.stageId);
        app.status = stage.kind === 'active' ? 'active' : stage.kind;
        await this.logActivity(caller.orgId, app.candidateId, 'system', 'Application re-activated', { applicationId: app.id, actorId: caller.userId });
      }
    }
    return this.applications.save(app);
  }

  async deleteApplication(caller: RecruitmentCaller, id: string) {
    const app = await this.requireApplication(caller.orgId, id);
    app.isDeleted = true;
    await this.applications.save(app);
    const opening = await this.openings.findOne({ where: { id: app.openingId } });
    await this.logActivity(caller.orgId, app.candidateId, 'system', `Removed from "${opening?.title ?? 'category'}"`, { applicationId: app.id, actorId: caller.userId });
    return { success: true as const };
  }

  /** Auto-close an opening once every position has a hire. */
  private async markOpeningFilledIfDone(orgId: string, openingId: string) {
    const opening = await this.openings.findOne({ where: { id: openingId, organizationId: orgId, isDeleted: false } });
    if (!opening || opening.status !== 'open') return;
    const hired = await this.applications.count({ where: { organizationId: orgId, openingId, status: 'hired', isDeleted: false } });
    if (hired >= (opening.positions || 1)) {
      opening.status = 'filled';
      opening.closedAt = new Date();
      await this.openings.save(opening);
    }
  }

  // ── timeline, people, notifications ───────────────────────────────────────────

  async logActivity(
    orgId: string, candidateId: string, type: CandidateActivityType, body: string | null,
    opts: { applicationId?: string | null; actorId?: string | null; meta?: Record<string, unknown>; occurredAt?: Date } = {},
  ) {
    const actor = opts.actorId ? await this.users.findOne({ where: { id: opts.actorId } }) : null;
    const now = new Date();
    const row = await this.activities.save(this.activities.create({
      organizationId: orgId, candidateId, applicationId: opts.applicationId ?? null, type, body, meta: opts.meta ?? null,
      occurredAt: opts.occurredAt ?? now, byUserId: opts.actorId ?? null, byUserName: actor ? nameOf(actor) : opts.actorId ? 'Member' : 'System',
      isDeleted: false,
    }));
    await this.candidates.update({ id: candidateId, organizationId: orgId }, { lastActivityAt: now });
    return row;
  }

  /** Org-wide audit feed (best-effort, never throws). */
  audit(caller: RecruitmentCaller, action: string, summary: string, target?: { type: string; id: string }, metadata?: Record<string, unknown>) {
    void this.activityFeed.record({
      organizationId: caller.orgId, actorId: caller.userId, action, category: 'recruitment',
      targetType: target?.type ?? null, targetId: target?.id ?? null, summary, metadata,
    });
  }

  async userNames(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
    const uniq = [...new Set(ids.filter((x): x is string => !!x))];
    if (!uniq.length) return new Map();
    const users = await this.users.find({ where: { id: In(uniq) } });
    return new Map(users.map((u) => [u.id, nameOf(u)]));
  }

  /** Active staff for owner / interviewer pickers (recruiters may lack employees:view). */
  async listPeople(orgId: string) {
    const rows = await this.memberships.find({ where: { organizationId: orgId, status: 'active', personType: 'staff' } });
    const userIds = rows.map((m) => m.userId).filter((x): x is string => !!x);
    const users = userIds.length ? await this.users.find({ where: { id: In(userIds) } }) : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows
      .filter((m) => m.userId && m.role !== 'client')
      .map((m) => {
        const u = byId.get(m.userId!);
        return { userId: m.userId!, name: u ? nameOf(u) : m.email ?? 'Member', email: u?.email ?? m.email, role: m.role, department: m.department };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Throws unless every id is an active staff member of the org (not a client/student/guardian). */
  async assertMembers(orgId: string, userIds: string[]) {
    const uniq = [...new Set(userIds.filter(Boolean))];
    if (!uniq.length) return;
    const found = await this.memberships.find({ where: { organizationId: orgId, userId: In(uniq), status: 'active', personType: 'staff' } });
    const ok = new Set(found.map((m) => m.userId));
    const missing = uniq.filter((id) => !ok.has(id));
    if (missing.length) throw new BadRequestException('One or more selected people are not members of this organization');
  }

  notify(input: Parameters<NotifierService['notify']>[0]) {
    if (!input.userId) return;
    void this.notifier?.notify(input).catch((err) => this.logger.warn(`notify failed: ${(err as Error).message}`));
  }
}
