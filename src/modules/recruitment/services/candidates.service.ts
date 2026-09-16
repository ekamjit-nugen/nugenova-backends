import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository, SelectQueryBuilder } from 'typeorm';

import { DomainEventsService } from '../../platform-events/domain-events.service';
import { DOMAIN_EVENTS } from '../../platform-events/domain-events';
import {
  ApplicationStageEventEntity, CandidateActivityEntity, CandidateApplicationEntity, CandidateDocumentEntity, CandidateEntity,
  CandidateOfferEntity, InterviewEntity, InterviewFeedbackEntity, RecruitmentOpeningEntity, RecruitmentStageEntity, RecruitmentSubmissionEntity,
} from '../entities';
import { CANDIDATE_POOLS, CandidatePool, RECRUITMENT_NOTIFICATIONS } from '../recruitment.constants';
import { cleanList, normalizeEmail, normalizePhone, tidyName, toPrefixTsQuery } from '../recruitment.utils';
import {
  AddDocumentDto, BulkCandidateActionDto, CandidateFieldsDto, CandidateFromCvDto, CreateCandidateActivityDto,
  CreateCandidateDto, MergeCandidatesDto, UpdateCandidateDto,
} from '../dto';
import { CvParseService } from './cv-parse.service';
import { MatchingService } from './matching.service';
import { SubmissionsService } from './submissions.service';
import { PipelineService } from './pipeline.service';
import { RecruitmentCaller, assertCan, can, toNum } from './recruitment-caller';

export interface CandidateListQuery {
  q?: string;
  source?: string;
  status?: string;
  ownerId?: string;
  openingId?: string;
  stageId?: string;
  applicationStatus?: string;
  expMin?: string | number;
  expMax?: string | number;
  location?: string;
  noticeMax?: string | number;
  skills?: string;
  tags?: string;
  hasResume?: string;
  updatedSince?: string;
  page?: string | number;
  limit?: string | number;
  sort?: string;
  order?: string;
  /** Talent-pool view: unassigned | pipeline | submitted | placed (default all). */
  pool?: string;
}

/** SQL fragments for the candidate pools (alias `c`). */
const ACTIVE_SUB_SQL = `'shortlisted','submitted','client_screening','client_interview','client_selected','on_hold'`;
export const POOL_SQL: Record<Exclude<CandidatePool, 'all'>, string> = {
  unassigned: `NOT EXISTS (SELECT 1 FROM candidate_applications pa WHERE pa.candidate_id = c.id AND pa.is_deleted = false AND pa.status IN ('active','hired'))
    AND NOT EXISTS (SELECT 1 FROM recruitment_submissions ps WHERE ps.candidate_id = c.id AND ps.is_deleted = false AND ps.status IN (${ACTIVE_SUB_SQL},'onboarded'))`,
  pipeline: `EXISTS (SELECT 1 FROM candidate_applications pa WHERE pa.candidate_id = c.id AND pa.is_deleted = false AND pa.status = 'active')`,
  submitted: `EXISTS (SELECT 1 FROM recruitment_submissions ps WHERE ps.candidate_id = c.id AND ps.is_deleted = false AND ps.status IN (${ACTIVE_SUB_SQL}))`,
  placed: `(EXISTS (SELECT 1 FROM candidate_applications pa WHERE pa.candidate_id = c.id AND pa.is_deleted = false AND pa.status = 'hired')
    OR EXISTS (SELECT 1 FROM recruitment_submissions ps WHERE ps.candidate_id = c.id AND ps.is_deleted = false AND ps.status = 'onboarded'))`,
};

const PROFILE_FIELDS = [
  'fullName', 'currentLocation', 'preferredLocations', 'willingToRelocate', 'totalExpMonths', 'relevantExpMonths',
  'currentCompany', 'currentDesignation', 'currency', 'noticePeriodDays', 'noticeStatus', 'lastWorkingDay',
  'highestQualification', 'education', 'workHistory', 'skills', 'linkedinUrl', 'githubUrl', 'portfolioUrl', 'source',
  'sourceDetail', 'referredBy', 'externalResumeUrl', 'tags', 'rating', 'aiSummary', 'status', 'altPhone',
] as const;

const isBlank = (v: unknown) => v == null || v === '' || (Array.isArray(v) && v.length === 0);
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/**
 * Candidates: the talent pool. Everything is org-scoped; reads need
 * `recruitment:view` — except an interviewer, who may open the profile of a
 * candidate they're scheduled to interview (limited view: no CTC, no notes,
 * no offers). CTC is only returned to callers with `recruitment:edit`.
 */
@Injectable()
export class CandidatesService {
  constructor(
    @InjectRepository(CandidateEntity) private readonly candidates: Repository<CandidateEntity>,
    @InjectRepository(CandidateDocumentEntity) private readonly documents: Repository<CandidateDocumentEntity>,
    @InjectRepository(CandidateApplicationEntity) private readonly applications: Repository<CandidateApplicationEntity>,
    @InjectRepository(ApplicationStageEventEntity) private readonly stageEvents: Repository<ApplicationStageEventEntity>,
    @InjectRepository(CandidateActivityEntity) private readonly activities: Repository<CandidateActivityEntity>,
    @InjectRepository(RecruitmentOpeningEntity) private readonly openings: Repository<RecruitmentOpeningEntity>,
    @InjectRepository(RecruitmentStageEntity) private readonly stages: Repository<RecruitmentStageEntity>,
    @InjectRepository(InterviewEntity) private readonly interviews: Repository<InterviewEntity>,
    @InjectRepository(InterviewFeedbackEntity) private readonly feedback: Repository<InterviewFeedbackEntity>,
    @InjectRepository(CandidateOfferEntity) private readonly offers: Repository<CandidateOfferEntity>,
    private readonly pipeline: PipelineService,
    private readonly cv: CvParseService,
    private readonly submissions: SubmissionsService,
    private readonly matching: MatchingService,
    @Optional() private readonly domainEvents?: DomainEventsService,
  ) {}

  // ── views ──────────────────────────────────────────────────────────────────────

  view(c: CandidateEntity, caller: RecruitmentCaller) {
    const showCtc = can(caller, 'edit');
    const { resumeText: _t, emailNorm: _e, ...rest } = c as CandidateEntity & { resumeText?: string };
    return {
      ...rest,
      currentCtc: showCtc ? toNum(c.currentCtc) : null,
      expectedCtc: showCtc ? toNum(c.expectedCtc) : null,
      ctcHidden: !showCtc,
    };
  }

  private docView(d: CandidateDocumentEntity) {
    return {
      id: d.id, candidateId: d.candidateId, fileId: d.fileId, kind: d.kind, fileName: d.fileName, mimeType: d.mimeType,
      size: toNum(d.size), isPrimary: d.isPrimary, version: d.version, parseStatus: d.parseStatus, createdAt: d.createdAt,
      createdBy: d.createdBy,
    };
  }

  // ── list / search ──────────────────────────────────────────────────────────────

  private applyFilters(qb: SelectQueryBuilder<CandidateEntity>, f: CandidateListQuery) {
    if (f.status) qb.andWhere('c.status IN (:...statuses)', { statuses: String(f.status).split(',') });
    else qb.andWhere(`c.status <> 'archived'`);
    if (f.source) qb.andWhere('c.source IN (:...sources)', { sources: String(f.source).split(',') });
    if (f.ownerId) qb.andWhere('c.owner_id = :ownerId', { ownerId: f.ownerId });
    if (f.pool && f.pool !== 'all') {
      if (!(CANDIDATE_POOLS as readonly string[]).includes(f.pool)) throw new BadRequestException('Unknown pool');
      qb.andWhere(POOL_SQL[f.pool as Exclude<CandidatePool, 'all'>]);
    }

    const q = f.q?.trim();
    if (q) {
      const tsq = toPrefixTsQuery(q);
      const digits = q.replace(/\D/g, '');
      qb.andWhere(new Brackets((b) => {
        if (tsq) b.orWhere(`c.search_tsv @@ to_tsquery('simple', :tsq)`, { tsq });
        b.orWhere('c.full_name ILIKE :like', { like: `%${escapeLike(q)}%` });
        b.orWhere('c.email ILIKE :like');
        if (digits.length >= 4) b.orWhere('c.phone_norm LIKE :digits', { digits: `%${digits}%` });
      }));
    }

    if (f.openingId || f.stageId || f.applicationStatus) {
      const cond = ['a.candidate_id = c.id', 'a.is_deleted = false'];
      if (f.openingId) cond.push('a.opening_id = :openingId');
      if (f.stageId) cond.push('a.stage_id = :stageId');
      if (f.applicationStatus) cond.push('a.status IN (:...appStatuses)');
      qb.andWhere(`EXISTS (SELECT 1 FROM candidate_applications a WHERE ${cond.join(' AND ')})`, {
        openingId: f.openingId, stageId: f.stageId, appStatuses: f.applicationStatus ? String(f.applicationStatus).split(',') : undefined,
      });
    }

    const expMin = f.expMin !== undefined && f.expMin !== '' ? Number(f.expMin) : NaN;
    const expMax = f.expMax !== undefined && f.expMax !== '' ? Number(f.expMax) : NaN;
    if (Number.isFinite(expMin)) qb.andWhere('c.total_exp_months >= :expMin', { expMin: Math.round(expMin * 12) });
    if (Number.isFinite(expMax)) qb.andWhere('c.total_exp_months <= :expMax', { expMax: Math.round(expMax * 12) });

    const noticeMax = f.noticeMax !== undefined && f.noticeMax !== '' ? Number(f.noticeMax) : NaN;
    if (Number.isFinite(noticeMax)) qb.andWhere(`(c.notice_period_days <= :noticeMax OR c.notice_status = 'immediate')`, { noticeMax });

    if (f.location?.trim()) {
      qb.andWhere(`(c.current_location ILIKE :loc OR c.preferred_locations::text ILIKE :loc)`, { loc: `%${escapeLike(f.location.trim())}%` });
    }
    cleanList(f.skills ?? '', 10).forEach((skill, i) => {
      qb.andWhere(`EXISTS (SELECT 1 FROM jsonb_array_elements_text(c.skills) s WHERE s ILIKE :skill${i})`, { [`skill${i}`]: `%${escapeLike(skill)}%` });
    });
    const tags = cleanList(f.tags ?? '', 10);
    if (tags.length) {
      qb.andWhere(`EXISTS (SELECT 1 FROM jsonb_array_elements_text(c.tags) t WHERE lower(t) IN (:...tags))`, { tags: tags.map((t) => t.toLowerCase()) });
    }
    if (f.hasResume === '1' || f.hasResume === 'true') {
      qb.andWhere(`EXISTS (SELECT 1 FROM candidate_documents d WHERE d.candidate_id = c.id AND d.is_deleted = false AND d.kind = 'resume')`);
    } else if (f.hasResume === '0' || f.hasResume === 'false') {
      qb.andWhere(`NOT EXISTS (SELECT 1 FROM candidate_documents d WHERE d.candidate_id = c.id AND d.is_deleted = false AND d.kind = 'resume')`);
    }
    if (f.updatedSince) {
      const d = new Date(f.updatedSince);
      if (!Number.isNaN(d.getTime())) qb.andWhere('c.updated_at >= :updatedSince', { updatedSince: d });
    }
  }

  async list(caller: RecruitmentCaller, f: CandidateListQuery, opts: { maxLimit?: number } = {}) {
    assertCan(caller, 'view');
    const maxLimit = opts.maxLimit ?? 200;
    const limit = Math.min(Math.max(Number(f.limit) || 50, 1), maxLimit);
    const page = Math.max(Number(f.page) || 1, 1);
    const qb = this.candidates.createQueryBuilder('c').where('c.organization_id = :orgId AND c.is_deleted = false', { orgId: caller.orgId });
    this.applyFilters(qb, f);

    const dir = String(f.order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    switch (f.sort) {
      case 'name': qb.orderBy('c.full_name', dir === 'DESC' && f.order ? 'DESC' : 'ASC'); break;
      case 'experience': qb.orderBy('c.total_exp_months', dir, 'NULLS LAST'); break;
      case 'notice': qb.orderBy('c.notice_period_days', dir === 'DESC' && f.order ? 'DESC' : 'ASC', 'NULLS LAST'); break;
      case 'created': qb.orderBy('c.created_at', dir); break;
      case 'activity': qb.orderBy('c.last_activity_at', dir, 'NULLS LAST'); break;
      default: qb.orderBy('c.updated_at', dir);
    }
    qb.addOrderBy('c.id', 'ASC');

    const [rows, total] = await qb.skip((page - 1) * limit).take(limit).getManyAndCount();
    const items = await this.decorate(caller, rows, f.pool === 'unassigned');
    return { items, total, page, limit };
  }

  /** Candidate counts per pool (tabs on the candidates page). */
  async poolCounts(caller: RecruitmentCaller) {
    assertCan(caller, 'view');
    const base = () => this.candidates.createQueryBuilder('c')
      .where(`c.organization_id = :orgId AND c.is_deleted = false AND c.status <> 'archived'`, { orgId: caller.orgId });
    const [all, unassigned, pipeline, submitted, placed] = await Promise.all([
      base().getCount(),
      base().andWhere(POOL_SQL.unassigned).getCount(),
      base().andWhere(POOL_SQL.pipeline).getCount(),
      base().andWhere(POOL_SQL.submitted).getCount(),
      base().andWhere(POOL_SQL.placed).getCount(),
    ]);
    return { all, unassigned, pipeline, submitted, placed };
  }

  /** Attach application summaries, owner names and the primary CV to list rows. */
  private async decorate(caller: RecruitmentCaller, rows: CandidateEntity[], withSuggestions = false) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [apps, docs, stages, subs, suggestions] = await Promise.all([
      this.applications.find({ where: { organizationId: caller.orgId, candidateId: In(ids), isDeleted: false }, order: { stageChangedAt: 'DESC' } }),
      this.documents.find({ where: { organizationId: caller.orgId, candidateId: In(ids), kind: 'resume', isPrimary: true, isDeleted: false } }),
      this.pipeline.ensureStages(caller.orgId),
      this.submissions.summariesForCandidates(caller.orgId, ids),
      withSuggestions ? this.matching.topSuggestionFor(caller.orgId, rows) : Promise.resolve(new Map()),
    ]);
    const openingIds = [...new Set(apps.map((a) => a.openingId))];
    const openings = openingIds.length ? await this.openings.find({ where: { id: In(openingIds) } }) : [];
    const openingById = new Map(openings.map((o) => [o.id, o]));
    const stageById = new Map(stages.map((s) => [s.id, s]));
    const names = await this.pipeline.userNames(rows.map((r) => r.ownerId));
    const docByCandidate = new Map(docs.map((d) => [d.candidateId, d]));
    return rows.map((c) => ({
      ...this.view(c, caller),
      ownerName: c.ownerId ? names.get(c.ownerId) ?? null : null,
      primaryResume: docByCandidate.has(c.id) ? this.docView(docByCandidate.get(c.id)!) : null,
      applications: apps.filter((a) => a.candidateId === c.id).map((a) => ({
        id: a.id, openingId: a.openingId, openingTitle: openingById.get(a.openingId)?.title ?? 'Opening',
        stageId: a.stageId, stageName: stageById.get(a.stageId)?.name ?? '—', stageColor: stageById.get(a.stageId)?.color ?? null,
        stageKind: stageById.get(a.stageId)?.kind ?? 'active', status: a.status, stageChangedAt: a.stageChangedAt,
      })),
      submissions: subs.filter((x) => x.candidateId === c.id),
      topSuggestion: suggestions.get(c.id) ?? null,
    }));
  }

  // ── detail ─────────────────────────────────────────────────────────────────────

  /** Full access with recruitment:view; limited access for an assigned interviewer. */
  async accessLevel(caller: RecruitmentCaller, candidateId: string): Promise<'full' | 'interviewer'> {
    if (can(caller, 'view')) return 'full';
    const assigned = await this.interviews.createQueryBuilder('i')
      .where('i.organization_id = :orgId AND i.candidate_id = :candidateId AND i.is_deleted = false', { orgId: caller.orgId, candidateId })
      .andWhere('i.interviewer_ids @> :me::jsonb', { me: JSON.stringify([caller.userId]) })
      .getCount();
    if (!assigned) throw new NotFoundException('Candidate not found');
    return 'interviewer';
  }

  async get(caller: RecruitmentCaller, id: string) {
    const level = await this.accessLevel(caller, id);
    const c = await this.pipeline.requireCandidate(caller.orgId, id);
    const full = level === 'full';

    const [docs, apps, interviews, offers, activities, stages] = await Promise.all([
      this.documents.find({ where: { organizationId: caller.orgId, candidateId: id, isDeleted: false, ...(full ? {} : { kind: 'resume' as const }) }, order: { createdAt: 'DESC' } }),
      this.applications.find({ where: { organizationId: caller.orgId, candidateId: id, isDeleted: false }, order: { appliedAt: 'DESC' } }),
      this.interviews.find({ where: { organizationId: caller.orgId, candidateId: id, isDeleted: false }, order: { scheduledAt: 'DESC' } }),
      full ? this.offers.find({ where: { organizationId: caller.orgId, candidateId: id, isDeleted: false }, order: { createdAt: 'DESC' } }) : Promise.resolve([]),
      full ? this.activities.find({ where: { organizationId: caller.orgId, candidateId: id, isDeleted: false }, order: { occurredAt: 'DESC' }, take: 300 }) : Promise.resolve([]),
      this.pipeline.ensureStages(caller.orgId),
    ]);
    const appIds = apps.map((a) => a.id);
    const [events, openings, feedbackRows] = await Promise.all([
      appIds.length ? this.stageEvents.find({ where: { organizationId: caller.orgId, applicationId: In(appIds) }, order: { at: 'ASC' } }) : Promise.resolve([] as ApplicationStageEventEntity[]),
      apps.length ? this.openings.find({ where: { id: In([...new Set(apps.map((a) => a.openingId))]) } }) : Promise.resolve([] as RecruitmentOpeningEntity[]),
      interviews.length ? this.feedback.find({ where: { organizationId: caller.orgId, interviewId: In(interviews.map((i) => i.id)) } }) : Promise.resolve([] as InterviewFeedbackEntity[]),
    ]);
    const stageById = new Map(stages.map((s) => [s.id, s]));
    const openingById = new Map(openings.map((o) => [o.id, o]));
    const names = await this.pipeline.userNames([
      c.ownerId, c.createdBy, c.referredBy, ...apps.map((a) => a.ownerId), ...events.map((e) => e.byUserId),
      ...interviews.flatMap((i) => i.interviewerIds), ...feedbackRows.map((f) => f.interviewerId), ...docs.map((d) => d.createdBy),
    ]);
    const showCtc = can(caller, 'edit');

    const visibleInterviews = full ? interviews : interviews.filter((i) => i.interviewerIds.includes(caller.userId));
    return {
      access: level,
      candidate: {
        ...this.view(c, caller),
        ownerName: c.ownerId ? names.get(c.ownerId) ?? null : null,
        createdByName: c.createdBy ? names.get(c.createdBy) ?? null : null,
        referredByName: c.referredBy ? names.get(c.referredBy) ?? null : null,
      },
      documents: docs.map((d) => ({ ...this.docView(d), createdByName: d.createdBy ? names.get(d.createdBy) ?? null : null })),
      applications: apps.map((a) => {
        const o = openingById.get(a.openingId);
        return {
          ...a,
          openingTitle: o?.title ?? 'Opening', openingStatus: o?.status ?? null,
          stageName: stageById.get(a.stageId)?.name ?? '—', stageKind: stageById.get(a.stageId)?.kind ?? 'active', stageColor: stageById.get(a.stageId)?.color ?? null,
          ownerName: a.ownerId ? names.get(a.ownerId) ?? null : null,
          events: full ? events.filter((e) => e.applicationId === a.id).map((e) => ({
            ...e, fromStageName: e.fromStageId ? stageById.get(e.fromStageId)?.name ?? '—' : null,
            toStageName: stageById.get(e.toStageId)?.name ?? '—', byUserName: e.byUserId ? names.get(e.byUserId) ?? null : null,
          })) : [],
        };
      }),
      interviews: visibleInterviews.map((i) => {
        const fb = feedbackRows.filter((f) => f.interviewId === i.id);
        const mine = fb.find((f) => f.interviewerId === caller.userId);
        const canSeeAll = full || !!mine;
        return {
          ...i,
          openingTitle: (i.openingId && openingById.get(i.openingId)?.title) || (i.kind === 'client' ? 'Client round' : 'Opening'),
          interviewers: i.interviewerIds.map((uid) => ({ id: uid, name: names.get(uid) ?? 'Member', submitted: fb.some((f) => f.interviewerId === uid) })),
          feedback: (canSeeAll ? fb : []).map((f) => ({ ...f, overallRating: toNum(f.overallRating), interviewerName: names.get(f.interviewerId) ?? 'Member' })),
        };
      }),
      offers: offers.map((o) => ({ ...o, offeredCtc: showCtc ? toNum(o.offeredCtc) : null, openingTitle: openingById.get(o.openingId)?.title ?? 'Opening' })),
      activities,
      duplicates: full ? (await this.cv.findDuplicates(caller.orgId, { name: c.fullName, excludeId: c.id })) : [],
      submissions: full ? await this.submissions.list(caller, { candidateId: c.id }) : [],
    };
  }

  // ── create / update ────────────────────────────────────────────────────────────

  /** Copy DTO fields onto an entity. `onlyBlank` fills gaps without overwriting. */
  applyFields(c: CandidateEntity, dto: CandidateFieldsDto, onlyBlank = false) {
    const set = <K extends keyof CandidateEntity>(key: K, value: CandidateEntity[K]) => {
      if (value === undefined) return;
      if (onlyBlank && !isBlank(c[key])) return;
      c[key] = value;
    };
    for (const key of PROFILE_FIELDS) {
      const raw = (dto as any)[key];
      if (raw === undefined) continue;
      let value: any = raw;
      if (key === 'fullName') value = tidyName(raw) ?? c.fullName;
      else if (key === 'skills' || key === 'tags' || key === 'preferredLocations') value = cleanList(raw, key === 'skills' ? 100 : 30);
      else if (key === 'altPhone') value = normalizePhone(raw);
      else if (key === 'currency') value = String(raw || 'INR').toUpperCase();
      else if (typeof raw === 'string') value = raw.trim() || null;
      set(key as keyof CandidateEntity, value);
    }
    if (dto.currentCtc !== undefined) set('currentCtc', dto.currentCtc == null ? null : String(dto.currentCtc));
    if (dto.expectedCtc !== undefined) set('expectedCtc', dto.expectedCtc == null ? null : String(dto.expectedCtc));
    if (dto.ownerId !== undefined) set('ownerId', dto.ownerId || null);
    if (dto.consent === true && !c.consentAt) c.consentAt = new Date();
  }

  /** Set email/phone with normalisation + per-org uniqueness. */
  private async applyContact(c: CandidateEntity, dto: { email?: string | null; phone?: string | null }, onlyBlank = false) {
    if (dto.email !== undefined && !(onlyBlank && c.email)) {
      const norm = normalizeEmail(dto.email);
      if (dto.email && !norm) throw new BadRequestException('Email address looks invalid');
      c.email = norm;
      c.emailNorm = norm;
    }
    if (dto.phone !== undefined && !(onlyBlank && c.phone)) {
      const norm = normalizePhone(dto.phone);
      if (dto.phone && !norm) throw new BadRequestException('Phone number looks invalid');
      c.phone = norm;
      c.phoneNorm = norm;
    }
    await this.assertUniqueContact(c);
  }

  private async assertUniqueContact(c: CandidateEntity) {
    const clash = await this.cv.findDuplicates(c.organizationId, { email: c.emailNorm, phone: c.phoneNorm, excludeId: c.id });
    const hard = clash.find((d) => d.matchedOn.includes('email') || d.matchedOn.includes('phone'));
    if (hard) {
      throw new ConflictException({
        code: 'DUPLICATE_CANDIDATE',
        message: `${hard.fullName} already has this ${hard.matchedOn.includes('email') ? 'email' : 'phone number'}`,
        duplicateId: hard.id,
      });
    }
  }

  async create(caller: RecruitmentCaller, dto: CreateCandidateDto) {
    assertCan(caller, 'create');
    if (dto.ownerId) await this.pipeline.assertMembers(caller.orgId, [dto.ownerId]);
    if (dto.referredBy) await this.pipeline.assertMembers(caller.orgId, [dto.referredBy]);
    const c = this.candidates.create({
      organizationId: caller.orgId, fullName: tidyName(dto.fullName) ?? dto.fullName.trim(), source: 'other', status: 'active',
      currency: 'INR', noticeStatus: 'unknown', preferredLocations: [], education: [], workHistory: [], skills: [], tags: [],
      createdBy: caller.userId, ownerId: caller.userId, isDeleted: false,
    });
    this.applyFields(c, dto);
    if (!c.fullName) throw new BadRequestException('Name is required');
    await this.applyContact(c, dto);
    const saved = await this.saveCandidate(c);

    await this.pipeline.logActivity(caller.orgId, saved.id, 'system', `Candidate added${saved.source !== 'other' ? ` (source: ${saved.source})` : ''}`, { actorId: caller.userId });
    if (dto.resumeFileId) await this.addDocument(caller, saved.id, { fileId: dto.resumeFileId, kind: 'resume', makePrimary: true });
    if (dto.openingId) await this.pipeline.createApplication(caller, { candidateId: saved.id, openingId: dto.openingId, stageId: dto.stageId });
    this.afterCreate(caller, saved);
    return this.view(saved, caller);
  }

  /** Save, translating a unique-index race into the friendly 409. */
  private async saveCandidate(c: CandidateEntity): Promise<CandidateEntity> {
    try {
      return await this.candidates.save(c);
    } catch (err: any) {
      if (err?.code === '23505') {
        await this.assertUniqueContact(c);
        throw new ConflictException('A candidate with this email or phone already exists');
      }
      throw err;
    }
  }

  private afterCreate(caller: RecruitmentCaller, c: CandidateEntity) {
    this.domainEvents?.emit(DOMAIN_EVENTS.CANDIDATE_CREATED, { organizationId: caller.orgId, actorId: caller.userId, candidateId: c.id, source: c.source });
    this.pipeline.audit(caller, 'recruitment.candidate_created', `Added candidate ${c.fullName}`, { type: 'candidate', id: c.id });
    if (c.ownerId && c.ownerId !== caller.userId) this.notifyOwner(caller, c);
  }

  private notifyOwner(caller: RecruitmentCaller, c: CandidateEntity) {
    this.pipeline.notify({
      organizationId: caller.orgId, userId: c.ownerId!, actorId: caller.userId, type: RECRUITMENT_NOTIFICATIONS.CANDIDATE_ASSIGNED,
      title: `You own a candidate: ${c.fullName}`, body: [c.currentDesignation, c.currentCompany].filter(Boolean).join(' · ') || null,
      data: { actionUrl: `/recruitment/candidates/${c.id}`, candidateId: c.id },
    });
  }

  async update(caller: RecruitmentCaller, id: string, dto: UpdateCandidateDto) {
    assertCan(caller, 'edit');
    const c = await this.pipeline.requireCandidate(caller.orgId, id);
    const prevOwner = c.ownerId;
    const prevStatus = c.status;
    if (dto.ownerId) await this.pipeline.assertMembers(caller.orgId, [dto.ownerId]);
    if (dto.referredBy) await this.pipeline.assertMembers(caller.orgId, [dto.referredBy]);
    this.applyFields(c, dto);
    await this.applyContact(c, dto);
    const saved = await this.saveCandidate(c);
    if (saved.status !== prevStatus) {
      await this.pipeline.logActivity(caller.orgId, id, 'system', `Status changed from ${prevStatus} to ${saved.status}`, { actorId: caller.userId });
    }
    if (saved.ownerId && saved.ownerId !== prevOwner) {
      const names = await this.pipeline.userNames([saved.ownerId]);
      await this.pipeline.logActivity(caller.orgId, id, 'system', `Owner set to ${names.get(saved.ownerId) ?? 'Member'}`, { actorId: caller.userId });
      if (saved.ownerId !== caller.userId) this.notifyOwner(caller, saved);
    }
    return this.view(saved, caller);
  }

  async remove(caller: RecruitmentCaller, id: string) {
    assertCan(caller, 'delete');
    const c = await this.pipeline.requireCandidate(caller.orgId, id);
    c.isDeleted = true;
    await this.candidates.save(c);
    await this.applications.update({ organizationId: caller.orgId, candidateId: id, isDeleted: false }, { isDeleted: true });
    await this.interviews.update({ organizationId: caller.orgId, candidateId: id, isDeleted: false }, { isDeleted: true });
    await this.submissions.removeForCandidate(caller.orgId, id);
    this.pipeline.audit(caller, 'recruitment.candidate_deleted', `Deleted candidate ${c.fullName}`, { type: 'candidate', id });
    return { success: true as const };
  }

  duplicates(caller: RecruitmentCaller, q: { email?: string; phone?: string; name?: string; excludeId?: string }) {
    assertCan(caller, 'view');
    return this.cv.findDuplicates(caller.orgId, q);
  }

  // ── CV-driven create ───────────────────────────────────────────────────────────

  async fromCv(caller: RecruitmentCaller, dto: CandidateFromCvDto) {
    const file = await this.cv.requireOrgFile(caller.orgId, dto.fileId);
    let candidateId: string;
    let created = false;
    if (dto.candidateId) {
      assertCan(caller, 'edit');
      const c = await this.pipeline.requireCandidate(caller.orgId, dto.candidateId);
      const onlyBlank = !dto.overwrite;
      this.applyFields(c, { ...dto.data, ownerId: undefined, status: undefined }, onlyBlank);
      await this.applyContact(c, { email: dto.data.email, phone: dto.data.phone }, onlyBlank);
      await this.saveCandidate(c);
      candidateId = c.id;
    } else {
      if (!dto.data.fullName?.trim()) throw new BadRequestException('Name is required');
      const res = await this.create(caller, {
        ...dto.data, fullName: dto.data.fullName, source: dto.data.source ?? (/^cutshort[-_ ]/i.test(file.originalName) ? 'cutshort' : undefined),
      } as CreateCandidateDto);
      candidateId = res.id;
      created = true;
    }
    await this.addDocument(caller, candidateId, { fileId: file.id, kind: 'resume', makePrimary: true }, { parsedJson: dto.parsedJson ?? null, skipPermission: created });
    if (dto.openingId) {
      const exists = await this.applications.findOne({ where: { organizationId: caller.orgId, candidateId, openingId: dto.openingId, isDeleted: false } });
      if (!exists) await this.pipeline.createApplication(caller, { candidateId, openingId: dto.openingId, stageId: dto.stageId });
    }
    if (dto.submitTo) {
      await this.submissions.create(caller, { leadId: dto.submitTo.leadId, requirementId: dto.submitTo.requirementId, candidateId, note: 'Added from CV upload' })
        .catch((err) => { if (!(err instanceof ConflictException)) throw err; });
    }
    const c = await this.pipeline.requireCandidate(caller.orgId, candidateId);
    return { created, candidate: this.view(c, caller) };
  }

  // ── merge + bulk ───────────────────────────────────────────────────────────────

  async merge(caller: RecruitmentCaller, dto: MergeCandidatesDto) {
    assertCan(caller, 'edit');
    assertCan(caller, 'delete');
    if (dto.primaryId === dto.duplicateId) throw new BadRequestException('Pick two different candidates');
    const [primary, dup] = await Promise.all([
      this.pipeline.requireCandidate(caller.orgId, dto.primaryId),
      this.candidates.createQueryBuilder('c').addSelect('c.resumeText')
        .where('c.id = :id AND c.organization_id = :orgId AND c.is_deleted = false', { id: dto.duplicateId, orgId: caller.orgId }).getOne(),
    ]);
    if (!dup) throw new NotFoundException('Candidate not found');

    await this.candidates.manager.transaction(async (m) => {
      // Free the duplicate's unique contact keys before copying them over.
      await m.update(CandidateEntity, { id: dup.id }, { isDeleted: true, emailNorm: null, phoneNorm: null });

      const fill: CandidateFieldsDto = {};
      for (const key of PROFILE_FIELDS) (fill as any)[key] = (dup as any)[key];
      this.applyFields(primary, { ...fill, status: undefined, fullName: undefined }, true);
      primary.skills = cleanList([...(primary.skills ?? []), ...(dup.skills ?? [])], 100);
      primary.tags = cleanList([...(primary.tags ?? []), ...(dup.tags ?? [])], 30);
      if (!primary.email && dup.email) { primary.email = dup.email; primary.emailNorm = dup.email; }
      if (!primary.phone && dup.phone) { primary.phone = dup.phone; primary.phoneNorm = dup.phone; }
      if (primary.currentCtc == null) primary.currentCtc = dup.currentCtc;
      if (primary.expectedCtc == null) primary.expectedCtc = dup.expectedCtc;
      await m.save(primary);

      const dupApps = await m.find(CandidateApplicationEntity, { where: { organizationId: caller.orgId, candidateId: dup.id, isDeleted: false } });
      const primaryApps = await m.find(CandidateApplicationEntity, { where: { organizationId: caller.orgId, candidateId: primary.id, isDeleted: false } });
      for (const a of dupApps) {
        if (primaryApps.some((p) => p.openingId === a.openingId)) {
          a.isDeleted = true; // primary already in this opening's pipeline
        } else {
          a.candidateId = primary.id;
        }
        await m.save(a);
      }
      await m.update(InterviewEntity, { organizationId: caller.orgId, candidateId: dup.id }, { candidateId: primary.id });
      await m.update(CandidateOfferEntity, { organizationId: caller.orgId, candidateId: dup.id }, { candidateId: primary.id });
      // Client submissions: keep the primary's when both were put forward for the same lead requirement.
      const dupSubs = await m.find(RecruitmentSubmissionEntity, { where: { organizationId: caller.orgId, candidateId: dup.id, isDeleted: false } });
      const primarySubs = await m.find(RecruitmentSubmissionEntity, { where: { organizationId: caller.orgId, candidateId: primary.id, isDeleted: false } });
      for (const sb of dupSubs) {
        if (primarySubs.some((p) => p.leadId === sb.leadId && p.requirementId === sb.requirementId)) sb.isDeleted = true;
        else sb.candidateId = primary.id;
        await m.save(sb);
      }
      await m.update(CandidateActivityEntity, { organizationId: caller.orgId, candidateId: dup.id }, { candidateId: primary.id });
      const primaryHasResume = await m.count(CandidateDocumentEntity, { where: { candidateId: primary.id, kind: 'resume', isPrimary: true, isDeleted: false } });
      if (primaryHasResume) {
        await m.update(CandidateDocumentEntity, { organizationId: caller.orgId, candidateId: dup.id }, { candidateId: primary.id, isPrimary: false });
      } else {
        await m.update(CandidateDocumentEntity, { organizationId: caller.orgId, candidateId: dup.id }, { candidateId: primary.id });
        if (dup.resumeText) await m.update(CandidateEntity, { id: primary.id }, { resumeText: dup.resumeText });
      }
    });

    await this.pipeline.logActivity(caller.orgId, primary.id, 'system', `Merged duplicate profile "${dup.fullName}" into this candidate`, { actorId: caller.userId, meta: { mergedId: dup.id } });
    this.pipeline.audit(caller, 'recruitment.candidates_merged', `Merged ${dup.fullName} into ${primary.fullName}`, { type: 'candidate', id: primary.id });
    return this.view(await this.pipeline.requireCandidate(caller.orgId, primary.id), caller);
  }

  async bulk(caller: RecruitmentCaller, dto: BulkCandidateActionDto) {
    const ids = [...new Set(dto.candidateIds)];
    if (dto.action === 'delete') assertCan(caller, 'delete');
    else assertCan(caller, 'edit');
    const rows = await this.candidates.find({ where: { organizationId: caller.orgId, id: In(ids), isDeleted: false } });
    let done = 0;
    const errors: { id: string; error: string }[] = [];

    if (dto.action === 'add_to_opening') {
      if (!dto.openingId) throw new BadRequestException('Choose an opening');
      await this.pipeline.requireOpening(caller.orgId, dto.openingId);
      for (const c of rows) {
        try { await this.pipeline.createApplication(caller, { candidateId: c.id, openingId: dto.openingId }); done++; } catch (e) { errors.push({ id: c.id, error: (e as Error).message }); }
      }
    } else if (dto.action === 'add_tags' || dto.action === 'remove_tags') {
      const tags = cleanList(dto.tags ?? [], 30);
      if (!tags.length) throw new BadRequestException('Choose at least one tag');
      const lower = new Set(tags.map((t) => t.toLowerCase()));
      for (const c of rows) {
        c.tags = dto.action === 'add_tags' ? cleanList([...(c.tags ?? []), ...tags], 30) : (c.tags ?? []).filter((t) => !lower.has(t.toLowerCase()));
        done++;
      }
      await this.candidates.save(rows);
    } else if (dto.action === 'set_owner') {
      if (dto.ownerId) await this.pipeline.assertMembers(caller.orgId, [dto.ownerId]);
      for (const c of rows) { c.ownerId = dto.ownerId || null; done++; }
      await this.candidates.save(rows);
      if (dto.ownerId && dto.ownerId !== caller.userId && rows.length) {
        this.pipeline.notify({
          organizationId: caller.orgId, userId: dto.ownerId, actorId: caller.userId, type: RECRUITMENT_NOTIFICATIONS.CANDIDATE_ASSIGNED,
          title: `${rows.length} candidate(s) assigned to you`, body: rows.slice(0, 3).map((r) => r.fullName).join(', '),
          data: { actionUrl: `/recruitment/candidates?ownerId=${dto.ownerId}` },
        });
      }
    } else if (dto.action === 'set_status') {
      if (!dto.status) throw new BadRequestException('Choose a status');
      for (const c of rows) { c.status = dto.status as CandidateEntity['status']; done++; }
      await this.candidates.save(rows);
    } else if (dto.action === 'delete') {
      for (const c of rows) { await this.remove(caller, c.id); done++; }
    }
    return { done, skipped: ids.length - done, errors };
  }

  // ── documents ──────────────────────────────────────────────────────────────────

  async addDocument(
    caller: RecruitmentCaller, candidateId: string, dto: AddDocumentDto,
    opts: { parsedJson?: Record<string, unknown> | null; skipPermission?: boolean } = {},
  ) {
    if (!opts.skipPermission) assertCan(caller, 'edit');
    const c = await this.pipeline.requireCandidate(caller.orgId, candidateId);
    const file = await this.cv.requireOrgFile(caller.orgId, dto.fileId);
    const kind = (dto.kind ?? 'resume') as CandidateDocumentEntity['kind'];
    const already = await this.documents.findOne({ where: { organizationId: caller.orgId, candidateId, fileId: file.id, isDeleted: false } });
    if (already) return this.docView(already);

    const siblings = await this.documents.find({ where: { organizationId: caller.orgId, candidateId, kind, isDeleted: false } });
    const makePrimary = kind === 'resume' && (dto.makePrimary !== false || !siblings.some((d) => d.isPrimary));
    let extractedText: string | null = null;
    let parseStatus: CandidateDocumentEntity['parseStatus'] = opts.parsedJson ? 'parsed' : 'pending';
    if (kind === 'resume') {
      const t = await this.cv.textOf(file);
      extractedText = t.text || null;
      if (!t.text) parseStatus = t.status === 'error' ? 'failed' : 'no_text';
    }
    if (makePrimary) {
      for (const s of siblings.filter((d) => d.isPrimary)) { s.isPrimary = false; await this.documents.save(s); }
    }
    const doc = await this.documents.save(this.documents.create({
      organizationId: caller.orgId, candidateId, fileId: file.id, kind, fileName: file.originalName, mimeType: file.mimeType,
      size: file.size != null ? String(file.size) : null, isPrimary: makePrimary, version: siblings.length + 1,
      extractedText, parseStatus, parsedJson: opts.parsedJson ?? null, createdBy: caller.userId, isDeleted: false,
    }));
    if (makePrimary) await this.candidates.update({ id: c.id }, { resumeText: extractedText });
    await this.pipeline.logActivity(caller.orgId, candidateId, 'document',
      `${kind === 'resume' ? (siblings.length ? `Uploaded CV v${siblings.length + 1}` : 'Uploaded CV') : `Uploaded ${kind.replace('_', ' ')}`}: ${file.originalName}`,
      { actorId: caller.userId, meta: { documentId: doc.id } });
    return this.docView(doc);
  }

  async setPrimaryDocument(caller: RecruitmentCaller, candidateId: string, docId: string) {
    assertCan(caller, 'edit');
    const doc = await this.documents.createQueryBuilder('d').addSelect('d.extractedText')
      .where('d.id = :docId AND d.candidate_id = :candidateId AND d.organization_id = :orgId AND d.is_deleted = false', { docId, candidateId, orgId: caller.orgId })
      .getOne();
    if (!doc) throw new NotFoundException('Document not found');
    if (doc.kind !== 'resume') throw new BadRequestException('Only a CV can be the primary document');
    await this.documents.update({ organizationId: caller.orgId, candidateId, kind: 'resume' }, { isPrimary: false });
    await this.documents.update({ id: doc.id }, { isPrimary: true });
    await this.candidates.update({ id: candidateId, organizationId: caller.orgId }, { resumeText: doc.extractedText ?? null });
    return { success: true as const };
  }

  async removeDocument(caller: RecruitmentCaller, candidateId: string, docId: string) {
    assertCan(caller, 'edit');
    const doc = await this.documents.findOne({ where: { id: docId, candidateId, organizationId: caller.orgId, isDeleted: false } });
    if (!doc) throw new NotFoundException('Document not found');
    doc.isDeleted = true;
    const wasPrimary = doc.isPrimary;
    doc.isPrimary = false;
    await this.documents.save(doc);
    if (wasPrimary) {
      const next = await this.documents.createQueryBuilder('d').addSelect('d.extractedText')
        .where(`d.candidate_id = :candidateId AND d.organization_id = :orgId AND d.is_deleted = false AND d.kind = 'resume'`, { candidateId, orgId: caller.orgId })
        .orderBy('d.created_at', 'DESC').getOne();
      if (next) await this.documents.update({ id: next.id }, { isPrimary: true });
      await this.candidates.update({ id: candidateId, organizationId: caller.orgId }, { resumeText: next?.extractedText ?? null });
    }
    await this.pipeline.logActivity(caller.orgId, candidateId, 'document', `Removed ${doc.fileName}`, { actorId: caller.userId });
    return { success: true as const };
  }

  /** Audited handle to open a CV/document (the file itself streams from /media). */
  async accessDocument(caller: RecruitmentCaller, candidateId: string, docId: string) {
    const level = await this.accessLevel(caller, candidateId);
    const doc = await this.documents.findOne({ where: { id: docId, candidateId, organizationId: caller.orgId, isDeleted: false } });
    if (!doc || (level === 'interviewer' && doc.kind !== 'resume')) throw new NotFoundException('Document not found');
    const c = await this.pipeline.requireCandidate(caller.orgId, candidateId);
    this.pipeline.audit(caller, 'recruitment.document_viewed', `Opened ${doc.fileName} for ${c.fullName}`, { type: 'candidate', id: candidateId }, { documentId: doc.id });
    return this.docView(doc);
  }

  // ── timeline ───────────────────────────────────────────────────────────────────

  async addActivity(caller: RecruitmentCaller, candidateId: string, dto: CreateCandidateActivityDto) {
    if (!can(caller, 'edit') && !can(caller, 'create')) throw new ForbiddenException(`You don't have permission to edit recruitment`);
    await this.pipeline.requireCandidate(caller.orgId, candidateId);
    if (dto.applicationId) {
      const app = await this.pipeline.requireApplication(caller.orgId, dto.applicationId);
      if (app.candidateId !== candidateId) throw new BadRequestException('Application belongs to another candidate');
    }
    return this.pipeline.logActivity(caller.orgId, candidateId, dto.type as CandidateActivityEntity['type'], dto.body.trim(), {
      applicationId: dto.applicationId ?? null, actorId: caller.userId, occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : undefined,
    });
  }

  async deleteActivity(caller: RecruitmentCaller, candidateId: string, activityId: string) {
    const a = await this.activities.findOne({ where: { id: activityId, candidateId, organizationId: caller.orgId, isDeleted: false } });
    if (!a) throw new NotFoundException('Note not found');
    if (!['note', 'call', 'email', 'whatsapp'].includes(a.type)) throw new BadRequestException('System entries can’t be deleted');
    if (a.byUserId !== caller.userId && !can(caller, 'delete')) throw new ForbiddenException('You can only delete your own notes');
    a.isDeleted = true;
    await this.activities.save(a);
    return { success: true as const };
  }

  /**
   * Importer duplicate check. `merged` = the stored candidate this row IS (email /
   * phone match, or a contact-less name match); `possible` = same name but
   * different contact details — flagged for a human to review, never auto-merged.
   */
  async matchForImport(orgId: string, probe: { email: string | null; phone: string | null; name: string | null }) {
    const matches = await this.cv.findDuplicates(orgId, probe);
    const merged = matches.find((m) => m.matchedOn.includes('email'))
      ?? matches.find((m) => m.matchedOn.includes('phone'))
      ?? (!probe.email && !probe.phone ? matches.find((m) => m.matchedOn.includes('name') && !m.email && !m.phone) : undefined)
      ?? null;
    const possible = merged ? null : matches.find((m) => m.matchedOn.includes('name')) ?? null;
    return { merged, possible };
  }

  /** Used by the importer: find the stored candidate a normalised probe refers to. */
  async findExisting(orgId: string, probe: { email: string | null; phone: string | null; name: string | null }) {
    const matches = await this.cv.findDuplicates(orgId, probe);
    return (
      matches.find((m) => m.matchedOn.includes('email'))
      ?? matches.find((m) => m.matchedOn.includes('phone'))
      // Name-only match is trusted only when neither side has contact details.
      ?? (!probe.email && !probe.phone ? matches.find((m) => m.matchedOn.includes('name') && !m.email && !m.phone) : undefined)
      ?? null
    );
  }
}
