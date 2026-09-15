import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import {
  CandidateApplicationEntity, CandidateDocumentEntity, CandidateEntity, CandidateOfferEntity, InterviewEntity,
  InterviewFeedbackEntity, RecruitmentOpeningEntity,
} from '../entities';
import { cleanList } from '../recruitment.utils';
import { CreateOpeningDto, OpeningFieldsDto, UpdateOpeningDto } from '../dto';
import { PipelineService } from './pipeline.service';
import { RecruitmentCaller, can, toNum } from './recruitment-caller';

/** Job openings and the per-opening pipeline board. */
@Injectable()
export class OpeningsService {
  constructor(
    @InjectRepository(RecruitmentOpeningEntity) private readonly openings: Repository<RecruitmentOpeningEntity>,
    @InjectRepository(CandidateApplicationEntity) private readonly applications: Repository<CandidateApplicationEntity>,
    @InjectRepository(CandidateEntity) private readonly candidates: Repository<CandidateEntity>,
    @InjectRepository(CandidateDocumentEntity) private readonly documents: Repository<CandidateDocumentEntity>,
    @InjectRepository(InterviewEntity) private readonly interviews: Repository<InterviewEntity>,
    @InjectRepository(InterviewFeedbackEntity) private readonly feedback: Repository<InterviewFeedbackEntity>,
    @InjectRepository(CandidateOfferEntity) private readonly offers: Repository<CandidateOfferEntity>,
    private readonly pipeline: PipelineService,
  ) {}

  private view(o: RecruitmentOpeningEntity, caller: RecruitmentCaller) {
    const showBudget = can(caller, 'edit');
    return { ...o, budgetMin: showBudget ? toNum(o.budgetMin) : null, budgetMax: showBudget ? toNum(o.budgetMax) : null };
  }

  async list(caller: RecruitmentCaller, f: { status?: string; q?: string }) {
    const qb = this.openings.createQueryBuilder('o').where('o.organization_id = :orgId AND o.is_deleted = false', { orgId: caller.orgId });
    if (f.status) qb.andWhere('o.status IN (:...statuses)', { statuses: f.status.split(',') });
    if (f.q?.trim()) qb.andWhere('(o.title ILIKE :q OR o.code ILIKE :q OR o.location ILIKE :q)', { q: `%${f.q.trim()}%` });
    const rows = await qb
      .orderBy(`CASE o.status WHEN 'open' THEN 0 WHEN 'on_hold' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END`, 'ASC')
      .addOrderBy('o.created_at', 'DESC')
      .getMany();
    if (!rows.length) return [];

    const ids = rows.map((r) => r.id);
    const [stages, counts] = await Promise.all([
      this.pipeline.ensureStages(caller.orgId),
      this.applications.createQueryBuilder('a')
        .select('a.opening_id', 'openingId').addSelect('a.stage_id', 'stageId').addSelect('a.status', 'status')
        .addSelect('COUNT(*)::int', 'count').addSelect('MAX(a.applied_at)', 'lastAppliedAt')
        .where('a.organization_id = :orgId AND a.is_deleted = false AND a.opening_id IN (:...ids)', { orgId: caller.orgId, ids })
        .groupBy('a.opening_id').addGroupBy('a.stage_id').addGroupBy('a.status')
        .getRawMany<{ openingId: string; stageId: string; status: string; count: number; lastAppliedAt: Date }>(),
    ]);
    const names = await this.pipeline.userNames(rows.flatMap((r) => [r.hiringManagerId, ...(r.recruiterIds ?? [])]));
    return rows.map((o) => {
      const mine = counts.filter((c) => c.openingId === o.id);
      const sum = (pred: (c: (typeof counts)[number]) => boolean) => mine.filter(pred).reduce((s, c) => s + Number(c.count), 0);
      const last = mine.map((c) => c.lastAppliedAt).filter(Boolean).sort().pop() ?? null;
      return {
        ...this.view(o, caller),
        hiringManagerName: o.hiringManagerId ? names.get(o.hiringManagerId) ?? null : null,
        recruiters: (o.recruiterIds ?? []).map((id) => ({ id, name: names.get(id) ?? 'Member' })),
        counts: {
          total: sum(() => true),
          active: sum((c) => c.status === 'active'),
          hired: sum((c) => c.status === 'hired'),
          rejected: sum((c) => c.status === 'rejected'),
          byStage: stages.map((s) => ({ stageId: s.id, name: s.name, color: s.color, kind: s.kind, count: sum((c) => c.stageId === s.id && c.status !== 'withdrawn') })),
        },
        lastAppliedAt: last,
        daysOpen: o.openedAt ? Math.floor(((o.closedAt ? new Date(o.closedAt).getTime() : Date.now()) - new Date(o.openedAt).getTime()) / 86_400_000) : null,
      };
    });
  }

  async get(caller: RecruitmentCaller, id: string) {
    const o = await this.pipeline.requireOpening(caller.orgId, id);
    const [withCounts] = (await this.list(caller, {})).filter((x) => x.id === o.id);
    return withCounts ?? this.view(o, caller);
  }

  private async applyFields(caller: RecruitmentCaller, o: RecruitmentOpeningEntity, dto: OpeningFieldsDto) {
    if (dto.title !== undefined) {
      const title = dto.title.trim();
      if (!title) throw new BadRequestException('Title is required');
      o.title = title;
    }
    if (dto.code !== undefined) {
      const code = dto.code?.trim() || null;
      if (code) {
        const clash = await this.openings.createQueryBuilder('o')
          .where('o.organization_id = :orgId AND o.is_deleted = false AND lower(o.code) = lower(:code)', { orgId: caller.orgId, code })
          .andWhere(o.id ? 'o.id <> :id' : '1=1', { id: o.id }).getCount();
        if (clash) throw new ConflictException(`Another opening already uses the code "${code}"`);
      }
      o.code = code;
    }
    if (dto.hiringManagerId) await this.pipeline.assertMembers(caller.orgId, [dto.hiringManagerId]);
    if (dto.recruiterIds?.length) await this.pipeline.assertMembers(caller.orgId, dto.recruiterIds);

    const simple = ['departmentId', 'location', 'workMode', 'employmentType', 'expMinYears', 'expMaxYears', 'priority', 'targetDate', 'scorecardTemplateId', 'description', 'hiringManagerId'] as const;
    for (const key of simple) {
      const v = (dto as any)[key];
      if (v !== undefined) (o as any)[key] = typeof v === 'string' ? v.trim() || null : v;
    }
    if (dto.currency !== undefined) o.currency = (dto.currency || 'INR').toUpperCase();
    if (dto.positions !== undefined) o.positions = dto.positions;
    if (dto.budgetMin !== undefined) o.budgetMin = dto.budgetMin == null ? null : String(dto.budgetMin);
    if (dto.budgetMax !== undefined) o.budgetMax = dto.budgetMax == null ? null : String(dto.budgetMax);
    if (dto.skills !== undefined) o.skills = cleanList(dto.skills, 60);
    if (dto.recruiterIds !== undefined) o.recruiterIds = [...new Set(dto.recruiterIds)];
    if (o.expMinYears != null && o.expMaxYears != null && o.expMinYears > o.expMaxYears) throw new BadRequestException('Minimum experience is above the maximum');
    if (o.budgetMin != null && o.budgetMax != null && Number(o.budgetMin) > Number(o.budgetMax)) throw new BadRequestException('Minimum budget is above the maximum');
    if (dto.status !== undefined && dto.status !== o.status) {
      o.status = dto.status as RecruitmentOpeningEntity['status'];
      if (o.status === 'open' && !o.openedAt) o.openedAt = new Date();
      if (o.status === 'open' || o.status === 'on_hold') o.closedAt = null;
      if (o.status === 'closed' || o.status === 'filled') o.closedAt = o.closedAt ?? new Date();
    }
    if (o.workMode === 'remote' && dto.location === undefined && !o.location) o.location = 'Remote';
  }

  async create(caller: RecruitmentCaller, dto: CreateOpeningDto) {
    const o = this.openings.create({
      organizationId: caller.orgId, title: dto.title.trim(), status: 'open', priority: 'medium', workMode: 'onsite',
      employmentType: 'full_time', positions: 1, skills: [], recruiterIds: [], currency: 'INR', createdBy: caller.userId,
      openedAt: new Date(), isDeleted: false,
    });
    await this.applyFields(caller, o, dto);
    if (o.status === 'draft') o.openedAt = null;
    const saved = await this.openings.save(o);
    this.pipeline.audit(caller, 'recruitment.opening_created', `Created opening "${saved.title}"`, { type: 'opening', id: saved.id });
    return this.view(saved, caller);
  }

  /** Find an opening by title (case-insensitive) or create it — used by the importer. */
  async findOrCreateByTitle(caller: RecruitmentCaller, title: string, dryRun = false): Promise<{ id: string | null; title: string; created: boolean }> {
    const clean = title.trim().slice(0, 200);
    const existing = await this.openings.createQueryBuilder('o')
      .where('o.organization_id = :orgId AND o.is_deleted = false AND lower(o.title) = lower(:title)', { orgId: caller.orgId, title: clean })
      .getOne();
    if (existing) return { id: existing.id, title: existing.title, created: false };
    if (dryRun) return { id: null, title: clean, created: true };
    const o = await this.create(caller, { title: clean });
    return { id: o.id, title: o.title, created: true };
  }

  async update(caller: RecruitmentCaller, id: string, dto: UpdateOpeningDto) {
    const o = await this.pipeline.requireOpening(caller.orgId, id);
    await this.applyFields(caller, o, dto);
    const saved = await this.openings.save(o);
    return this.view(saved, caller);
  }

  async remove(caller: RecruitmentCaller, id: string) {
    const o = await this.pipeline.requireOpening(caller.orgId, id);
    const active = await this.applications.count({ where: { organizationId: caller.orgId, openingId: id, status: 'active', isDeleted: false } });
    if (active) throw new BadRequestException(`This opening has ${active} active candidate(s). Close it instead, or move them out first.`);
    o.isDeleted = true;
    await this.openings.save(o);
    await this.applications.update({ organizationId: caller.orgId, openingId: id, isDeleted: false }, { isDeleted: true });
    this.pipeline.audit(caller, 'recruitment.opening_deleted', `Deleted opening "${o.title}"`, { type: 'opening', id });
    return { success: true as const };
  }

  /** Kanban data: stages + one card per application. */
  async board(caller: RecruitmentCaller, id: string) {
    const opening = await this.pipeline.requireOpening(caller.orgId, id);
    const [stages, apps] = await Promise.all([
      this.pipeline.ensureStages(caller.orgId),
      this.applications.find({ where: { organizationId: caller.orgId, openingId: id, isDeleted: false }, order: { stageChangedAt: 'DESC' } }),
    ]);
    const candidateIds = [...new Set(apps.map((a) => a.candidateId))];
    const appIds = apps.map((a) => a.id);
    const [cands, docs, interviews, offers] = candidateIds.length ? await Promise.all([
      this.candidates.find({ where: { organizationId: caller.orgId, id: In(candidateIds), isDeleted: false } }),
      this.documents.find({ where: { organizationId: caller.orgId, candidateId: In(candidateIds), kind: 'resume', isPrimary: true, isDeleted: false } }),
      this.interviews.find({ where: { organizationId: caller.orgId, applicationId: In(appIds), isDeleted: false } }),
      this.offers.find({ where: { organizationId: caller.orgId, applicationId: In(appIds), isDeleted: false }, order: { createdAt: 'DESC' } }),
    ]) : [[], [], [], []];
    const fb = interviews.length ? await this.feedback.find({ where: { organizationId: caller.orgId, interviewId: In(interviews.map((i) => i.id)) } }) : [];
    const candById = new Map(cands.map((c) => [c.id, c]));
    const docByCand = new Map(docs.map((d) => [d.candidateId, d]));
    const names = await this.pipeline.userNames(apps.map((a) => a.ownerId));
    const now = Date.now();

    const cards = apps.filter((a) => candById.has(a.candidateId)).map((a) => {
      const c = candById.get(a.candidateId)!;
      const myInterviews = interviews.filter((i) => i.applicationId === a.id);
      const myFeedback = fb.filter((f) => myInterviews.some((i) => i.id === f.interviewId));
      const next = myInterviews.filter((i) => i.status === 'scheduled' && new Date(i.scheduledAt).getTime() >= now)
        .sort((x, y) => new Date(x.scheduledAt).getTime() - new Date(y.scheduledAt).getTime())[0];
      const offer = offers.find((o) => o.applicationId === a.id);
      const ratings = myFeedback.map((f) => toNum(f.overallRating)).filter((n): n is number => n != null);
      return {
        applicationId: a.id, stageId: a.stageId, status: a.status, rejectionReason: a.rejectionReason, appliedAt: a.appliedAt,
        stageChangedAt: a.stageChangedAt, daysInStage: Math.floor((now - new Date(a.stageChangedAt).getTime()) / 86_400_000),
        ownerId: a.ownerId, ownerName: a.ownerId ? names.get(a.ownerId) ?? null : null,
        candidate: {
          id: c.id, fullName: c.fullName, email: c.email, phone: c.phone, currentCompany: c.currentCompany,
          currentDesignation: c.currentDesignation, currentLocation: c.currentLocation, totalExpMonths: c.totalExpMonths,
          noticePeriodDays: c.noticePeriodDays, noticeStatus: c.noticeStatus, rating: c.rating, tags: c.tags, source: c.source,
          skills: (c.skills ?? []).slice(0, 5), lastActivityAt: c.lastActivityAt, hasResume: docByCand.has(c.id),
          primaryResumeFileId: docByCand.get(c.id)?.fileId ?? null,
        },
        interviews: {
          total: myInterviews.length,
          next: next ? { id: next.id, roundName: next.roundName, scheduledAt: next.scheduledAt } : null,
          feedbackCount: myFeedback.length,
          avgRating: ratings.length ? Math.round((ratings.reduce((s, r) => s + r, 0) / ratings.length) * 10) / 10 : null,
          recommendations: myFeedback.map((f) => f.recommendation),
        },
        offerStatus: offer?.status ?? null,
      };
    });
    return { opening: this.view(opening, caller), stages, cards };
  }

  /** Lookup used by other services. */
  async requireOpening(orgId: string, id: string) {
    const o = await this.openings.findOne({ where: { id, organizationId: orgId, isDeleted: false } });
    if (!o) throw new NotFoundException('Opening not found');
    return o;
  }
}
