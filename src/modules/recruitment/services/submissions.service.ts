import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { LeadEntity } from '../../sales/entities/lead.entity';
import { RequirementEntity } from '../../sales/entities/requirement.entity';
import { SalesService } from '../../sales/sales.service';
import { DomainEventsService } from '../../platform-events/domain-events.service';
import { DOMAIN_EVENTS } from '../../platform-events/domain-events';
import {
  CandidateDocumentEntity, CandidateEntity, RecruitmentSubmissionEntity, SubmissionEventEntity,
} from '../entities';
import { RECRUITMENT_NOTIFICATIONS } from '../recruitment.constants';
import {
  ACTIVE_SUBMISSION_STATUSES, BillUnit, SUBMISSION_LABEL, SubmissionStatus, checkTransition, costPerUnitFromAnnual, marginPct,
} from '../submission-rules';
import { BulkSubmissionDto, CreateSubmissionDto, MoveSubmissionDto, UpdateSubmissionDto } from '../dto';
import { PipelineService } from './pipeline.service';
import { RecruitmentCaller, assertCan, can, toNum } from './recruitment-caller';

const REQ_UNIT_TO_BILL: Record<string, BillUnit> = { hours: 'hour', days: 'day', fixed: 'fixed' };
/** Status changes worth a notification (the rest are day-to-day moves). */
const NOTIFY_ON: SubmissionStatus[] = ['submitted', 'client_selected', 'client_rejected', 'onboarded'];

export interface SubmissionFilters { leadId?: string; requirementId?: string; candidateId?: string; status?: string }

/**
 * Candidates submitted against Sales leads — the client-side staffing pipeline.
 * Every change writes an append-only event, a candidate timeline entry and an org
 * audit row. Deliberately does NOT write system rows into `sales_activities` (the
 * Sales team removed those in 977cac7); the lead workspace reads this history
 * from `recruitment_submission_events` instead.
 */
@Injectable()
export class SubmissionsService {
  constructor(
    @InjectRepository(RecruitmentSubmissionEntity) private readonly submissions: Repository<RecruitmentSubmissionEntity>,
    @InjectRepository(SubmissionEventEntity) private readonly events: Repository<SubmissionEventEntity>,
    @InjectRepository(CandidateEntity) private readonly candidates: Repository<CandidateEntity>,
    @InjectRepository(CandidateDocumentEntity) private readonly documents: Repository<CandidateDocumentEntity>,
    @InjectRepository(LeadEntity) private readonly leads: Repository<LeadEntity>,
    @InjectRepository(RequirementEntity) private readonly requirements: Repository<RequirementEntity>,
    private readonly pipeline: PipelineService,
    private readonly sales: SalesService,
    @Optional() private readonly domainEvents?: DomainEventsService,
  ) {}

  // ── lookups ────────────────────────────────────────────────────────────────────

  async requireLead(orgId: string, leadId: string): Promise<LeadEntity> {
    const lead = await this.leads.findOne({ where: { id: leadId, organizationId: orgId, isDeleted: false } });
    if (!lead) throw new NotFoundException('Lead not found');
    return lead;
  }

  async requireRequirement(orgId: string, leadId: string, requirementId: string): Promise<RequirementEntity> {
    const r = await this.requirements.findOne({ where: { id: requirementId, organizationId: orgId, entityType: 'lead', entityId: leadId, isDeleted: false } });
    if (!r) throw new NotFoundException('Requirement not found on this lead');
    return r;
  }

  async requireSubmission(orgId: string, id: string): Promise<RecruitmentSubmissionEntity> {
    const s = await this.submissions.findOne({ where: { id, organizationId: orgId, isDeleted: false } });
    if (!s) throw new NotFoundException('Submission not found');
    return s;
  }

  private label(lead: LeadEntity, req: RequirementEntity | null) {
    return `${lead.company || lead.name}${req ? ` — ${req.role || req.title}` : ''}`;
  }

  // ── views ──────────────────────────────────────────────────────────────────────

  private findByIds<T extends { id: string }>(repo: Repository<T>, ids: (string | null)[]): Promise<T[]> {
    const uniq = [...new Set(ids.filter((x): x is string => !!x))];
    return uniq.length ? repo.find({ where: { id: In(uniq) } as any }) : Promise.resolve([]);
  }

  async views(caller: RecruitmentCaller, rows: RecruitmentSubmissionEntity[]) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [cands, leads, reqs, docs, events] = await Promise.all([
      this.candidates.find({ where: { id: In([...new Set(rows.map((r) => r.candidateId))]) } }),
      this.leads.find({ where: { id: In([...new Set(rows.map((r) => r.leadId))]) } }),
      this.findByIds(this.requirements, rows.map((r) => r.requirementId)),
      this.findByIds(this.documents, rows.map((r) => r.sharedDocumentId)),
      this.events.find({ where: { organizationId: caller.orgId, submissionId: In(ids) }, order: { at: 'ASC' } }),
    ]);
    const names = await this.pipeline.userNames([...rows.flatMap((r) => [r.ownerId, r.accountManagerId]), ...events.map((e) => e.byUserId)]);
    const cById = new Map(cands.map((c) => [c.id, c]));
    const lById = new Map(leads.map((l) => [l.id, l]));
    const rById = new Map(reqs.map((r) => [r.id, r]));
    const dById = new Map(docs.map((d) => [d.id, d]));
    const showMoney = can(caller, 'edit');
    return rows.map((s) => {
      const c = cById.get(s.candidateId);
      const l = lById.get(s.leadId);
      const r = s.requirementId ? rById.get(s.requirementId) : null;
      const d = s.sharedDocumentId ? dById.get(s.sharedDocumentId) : null;
      const bill = toNum(s.billRate);
      const cost = toNum(s.costRate);
      return {
        id: s.id, leadId: s.leadId, leadName: l?.name ?? 'Lead', leadCompany: l?.company ?? null,
        requirementId: s.requirementId, requirementTitle: r ? (r.role || r.title) : null,
        candidateId: s.candidateId, applicationId: s.applicationId, status: s.status,
        candidate: c ? {
          id: c.id, fullName: c.fullName, email: c.email, phone: c.phone, currentDesignation: c.currentDesignation,
          currentCompany: c.currentCompany, totalExpMonths: c.totalExpMonths, noticePeriodDays: c.noticePeriodDays,
          noticeStatus: c.noticeStatus, skills: (c.skills ?? []).slice(0, 8),
        } : null,
        billRate: bill, billUnit: s.billUnit, currency: s.currency,
        costRate: showMoney ? cost : null, marginPct: showMoney ? marginPct(bill, cost) : null, moneyHidden: !showMoney,
        availableFrom: s.availableFrom, proposedStart: s.proposedStart,
        sharedDocument: d ? { id: d.id, fileId: d.fileId, fileName: d.fileName, mimeType: d.mimeType } : null,
        clientFeedback: s.clientFeedback, rejectionReason: s.rejectionReason,
        ownerId: s.ownerId, ownerName: s.ownerId ? names.get(s.ownerId) ?? null : null,
        accountManagerId: s.accountManagerId, accountManagerName: s.accountManagerId ? names.get(s.accountManagerId) ?? null : null,
        submittedAt: s.submittedAt, decidedAt: s.decidedAt, createdAt: s.createdAt, updatedAt: s.updatedAt,
        events: events.filter((e) => e.submissionId === s.id).map((e) => ({
          id: e.id, fromStatus: e.fromStatus, toStatus: e.toStatus, note: e.note, at: e.at,
          byUserName: e.byUserId ? names.get(e.byUserId) ?? 'Member' : 'System',
        })),
      };
    });
  }

  async list(caller: RecruitmentCaller, f: SubmissionFilters) {
    assertCan(caller, 'view');
    const where: Record<string, unknown> = { organizationId: caller.orgId, isDeleted: false };
    if (f.leadId) where.leadId = f.leadId;
    if (f.requirementId) where.requirementId = f.requirementId;
    if (f.candidateId) where.candidateId = f.candidateId;
    if (f.status) where.status = In(f.status.split(','));
    const rows = await this.submissions.find({ where, order: { updatedAt: 'DESC' }, take: 1000 });
    return this.views(caller, rows);
  }

  async get(caller: RecruitmentCaller, id: string) {
    const [view] = await this.views(caller, [await this.requireSubmission(caller.orgId, id)]);
    return view;
  }

  // ── create ─────────────────────────────────────────────────────────────────────

  async create(caller: RecruitmentCaller, dto: CreateSubmissionDto, opts: { silentNotify?: boolean } = {}) {
    const lead = await this.requireLead(caller.orgId, dto.leadId);
    if (lead.status === 'lost') throw new BadRequestException('This lead is marked lost — reopen it before submitting candidates');
    const req = dto.requirementId ? await this.requireRequirement(caller.orgId, lead.id, dto.requirementId) : null;
    if (req && (req.status === 'dropped' || req.status === 'fulfilled')) {
      throw new BadRequestException(`This requirement is ${req.status} — reopen it before submitting more candidates`);
    }
    const candidate = await this.pipeline.requireCandidate(caller.orgId, dto.candidateId);
    if (candidate.status === 'blacklisted') throw new BadRequestException(`${candidate.fullName} is marked “Do not hire”`);
    if (dto.ownerId) await this.pipeline.assertMembers(caller.orgId, [dto.ownerId]);
    if (dto.applicationId) {
      const app = await this.pipeline.requireApplication(caller.orgId, dto.applicationId);
      if (app.candidateId !== candidate.id) throw new BadRequestException('Application belongs to another candidate');
    }

    const dupe = await this.submissions.createQueryBuilder('s')
      .where('s.organization_id = :orgId AND s.lead_id = :leadId AND s.candidate_id = :cid AND s.is_deleted = false', { orgId: caller.orgId, leadId: lead.id, cid: candidate.id })
      .andWhere(req ? 's.requirement_id = :rid' : 's.requirement_id IS NULL', { rid: req?.id })
      .getOne();
    if (dupe) {
      throw new ConflictException({ code: 'DUPLICATE_SUBMISSION', message: `${candidate.fullName} is already submitted to ${this.label(lead, req)}`, submissionId: dupe.id });
    }

    let sharedDocumentId: string | null = null;
    if (dto.sharedDocumentId) {
      const doc = await this.documents.findOne({ where: { id: dto.sharedDocumentId, candidateId: candidate.id, organizationId: caller.orgId, isDeleted: false } });
      if (!doc) throw new BadRequestException('That CV does not belong to this candidate');
      sharedDocumentId = doc.id;
    } else {
      const primary = await this.documents.findOne({ where: { candidateId: candidate.id, organizationId: caller.orgId, kind: 'resume', isPrimary: true, isDeleted: false } });
      sharedDocumentId = primary?.id ?? null;
    }

    const billUnit = (dto.billUnit as BillUnit) ?? (req ? REQ_UNIT_TO_BILL[req.unit] : undefined) ?? 'month';
    const annual = toNum(candidate.expectedCtc) ?? toNum(candidate.currentCtc);
    const billRate = dto.billRate ?? (req && REQ_UNIT_TO_BILL[req.unit] === billUnit && Number(req.rate) > 0 ? Number(req.rate) : null);
    const costRate = dto.costRate ?? costPerUnitFromAnnual(annual, billUnit);
    const status: SubmissionStatus = (dto.status as SubmissionStatus) ?? 'shortlisted';
    const now = new Date();

    let saved: RecruitmentSubmissionEntity;
    try {
      saved = await this.submissions.save(this.submissions.create({
        organizationId: caller.orgId, leadId: lead.id, requirementId: req?.id ?? null, candidateId: candidate.id,
        applicationId: dto.applicationId ?? null, status, billRate: billRate != null ? String(billRate) : null, billUnit,
        costRate: costRate != null ? String(costRate) : null, currency: (dto.currency || lead.currency || 'INR').toUpperCase(),
        availableFrom: dto.availableFrom ?? null, proposedStart: dto.proposedStart ?? null, sharedDocumentId,
        ownerId: dto.ownerId ?? candidate.ownerId ?? caller.userId, accountManagerId: lead.assignedTo ?? null,
        submittedAt: status === 'submitted' ? now : null, createdBy: caller.userId, isDeleted: false,
      }));
    } catch (err: any) {
      if (err?.code === '23505') throw new ConflictException(`${candidate.fullName} is already submitted to ${this.label(lead, req)}`);
      throw err;
    }

    await this.events.save(this.events.create({
      organizationId: caller.orgId, submissionId: saved.id, fromStatus: null, toStatus: status, note: dto.note?.trim() || null, byUserId: caller.userId, at: now,
    }));
    await this.pipeline.logActivity(caller.orgId, candidate.id, 'submission',
      `${SUBMISSION_LABEL[status]} for ${this.label(lead, req)}${dto.note?.trim() ? `\n${dto.note.trim()}` : ''}`,
      { actorId: caller.userId, meta: { submissionId: saved.id, leadId: lead.id, requirementId: req?.id ?? null } });
    this.pipeline.audit(caller, 'recruitment.submission_created', `${SUBMISSION_LABEL[status]} ${candidate.fullName} for ${this.label(lead, req)}`, { type: 'lead', id: lead.id }, { submissionId: saved.id });

    if (req && req.status === 'open') await this.sales.updateRequirement(caller.orgId, req.id, { status: 'in_progress' } as any);
    await this.leads.update({ id: lead.id, organizationId: caller.orgId }, { lastActivityAt: now });

    if (!opts.silentNotify && lead.assignedTo && lead.assignedTo !== caller.userId) {
      this.pipeline.notify({
        organizationId: caller.orgId, userId: lead.assignedTo, actorId: caller.userId, type: RECRUITMENT_NOTIFICATIONS.SUBMISSION_CREATED,
        title: `${candidate.fullName} ${status === 'submitted' ? 'shared with' : 'shortlisted for'} ${lead.company || lead.name}`,
        body: req ? (req.role || req.title) : null,
        data: { actionUrl: `/recruitment/leads/${lead.id}`, leadId: lead.id, submissionId: saved.id },
      });
    }
    this.domainEvents?.emit(DOMAIN_EVENTS.SUBMISSION_CREATED, {
      organizationId: caller.orgId, actorId: caller.userId, submissionId: saved.id, leadId: lead.id, requirementId: req?.id ?? null, candidateId: candidate.id,
    });
    return this.get(caller, saved.id);
  }

  async bulkCreate(caller: RecruitmentCaller, dto: BulkSubmissionDto) {
    const results: { candidateId: string; ok: boolean; submissionId?: string; error?: string }[] = [];
    for (const candidateId of [...new Set(dto.candidateIds)]) {
      try {
        const s = await this.create(caller, { leadId: dto.leadId, requirementId: dto.requirementId, candidateId, note: dto.note });
        results.push({ candidateId, ok: true, submissionId: s.id });
      } catch (err: any) {
        results.push({ candidateId, ok: false, error: err?.response?.message ?? err?.message ?? 'Failed' });
      }
    }
    return { created: results.filter((r) => r.ok).length, results };
  }

  // ── status moves ───────────────────────────────────────────────────────────────

  async move(caller: RecruitmentCaller, id: string, dto: MoveSubmissionDto) {
    const s = await this.requireSubmission(caller.orgId, id);
    const to = dto.status as SubmissionStatus;
    const from = s.status;
    const check = checkTransition(from, to, dto.reason);
    if (!check.ok) throw new BadRequestException(check.error);

    const now = new Date();
    s.status = to;
    if (to === 'submitted' && !s.submittedAt) s.submittedAt = now;
    if (['client_selected', 'client_rejected', 'onboarded'].includes(to)) s.decidedAt = now;
    if (to === 'client_rejected' || to === 'withdrawn') s.rejectionReason = dto.reason!.trim();
    if (to === 'shortlisted') { s.rejectionReason = null; s.decidedAt = null; }
    if (dto.clientFeedback?.trim()) {
      const stamp = now.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
      s.clientFeedback = [s.clientFeedback, `[${stamp}] ${dto.clientFeedback.trim()}`].filter(Boolean).join('\n');
    }
    await this.submissions.save(s);

    const note = [dto.reason?.trim() ? `Reason: ${dto.reason.trim()}` : null, dto.clientFeedback?.trim() ? `Client: ${dto.clientFeedback.trim()}` : null, dto.note?.trim() || null]
      .filter(Boolean).join(' — ') || null;
    await this.events.save(this.events.create({ organizationId: caller.orgId, submissionId: s.id, fromStatus: from, toStatus: to, note, byUserId: caller.userId, at: now }));

    const [lead, req, candidate] = await Promise.all([
      this.leads.findOne({ where: { id: s.leadId } }),
      s.requirementId ? this.requirements.findOne({ where: { id: s.requirementId } }) : Promise.resolve(null),
      this.candidates.findOne({ where: { id: s.candidateId } }),
    ]);
    const where = lead ? this.label(lead, req) : 'client lead';
    await this.pipeline.logActivity(caller.orgId, s.candidateId, 'submission', `${SUBMISSION_LABEL[to]} — ${where}${note ? `\n${note}` : ''}`, {
      actorId: caller.userId, meta: { submissionId: s.id, fromStatus: from, toStatus: to },
    });
    this.pipeline.audit(caller, 'recruitment.submission_moved', `${candidate?.fullName ?? 'Candidate'}: ${SUBMISSION_LABEL[from]} → ${SUBMISSION_LABEL[to]} (${where})`, { type: 'lead', id: s.leadId }, { submissionId: s.id });
    if (lead) await this.leads.update({ id: lead.id }, { lastActivityAt: now });

    if (to === 'onboarded' && req) await this.maybeFulfil(caller, req);

    if (NOTIFY_ON.includes(to) && candidate && lead) {
      const recipients = new Set([s.ownerId, s.accountManagerId, lead.assignedTo].filter((x): x is string => !!x && x !== caller.userId));
      for (const userId of recipients) {
        this.pipeline.notify({
          organizationId: caller.orgId, userId, actorId: caller.userId, type: RECRUITMENT_NOTIFICATIONS.SUBMISSION_DECISION,
          title: `${candidate.fullName}: ${SUBMISSION_LABEL[to]}`, body: where,
          data: { actionUrl: `/recruitment/leads/${s.leadId}`, leadId: s.leadId, submissionId: s.id, candidateId: s.candidateId },
        });
      }
    }
    this.domainEvents?.emit(DOMAIN_EVENTS.SUBMISSION_STATUS_CHANGED, {
      organizationId: caller.orgId, actorId: caller.userId, submissionId: s.id, leadId: s.leadId, requirementId: s.requirementId,
      candidateId: s.candidateId, fromStatus: from, toStatus: to,
    });
    return this.get(caller, s.id);
  }

  /** Mark a requirement fulfilled once onboarded submissions reach its headcount. */
  private async maybeFulfil(caller: RecruitmentCaller, req: RequirementEntity) {
    if (!req.positions || req.status === 'fulfilled' || req.status === 'dropped') return;
    const onboarded = await this.submissions.count({ where: { organizationId: caller.orgId, requirementId: req.id, status: 'onboarded', isDeleted: false } });
    if (onboarded >= req.positions) await this.sales.updateRequirement(caller.orgId, req.id, { status: 'fulfilled' } as any);
  }

  /** Auto-advance used by client interviews (best effort, only if the move is allowed). */
  async advanceTo(caller: RecruitmentCaller, id: string, to: SubmissionStatus, note: string) {
    const s = await this.requireSubmission(caller.orgId, id);
    if (s.status === to || !checkTransition(s.status, to).ok) return;
    await this.move(caller, id, { status: to, note });
  }

  // ── edit / delete ──────────────────────────────────────────────────────────────

  async update(caller: RecruitmentCaller, id: string, dto: UpdateSubmissionDto) {
    const s = await this.requireSubmission(caller.orgId, id);
    const changes: string[] = [];
    const money = (v: number | null | undefined) => (v == null ? null : String(v));
    if (dto.billRate !== undefined && money(dto.billRate) !== s.billRate) { s.billRate = money(dto.billRate); changes.push('bill rate'); }
    if (dto.billUnit !== undefined && dto.billUnit !== s.billUnit) { s.billUnit = dto.billUnit as BillUnit; changes.push('bill unit'); }
    if (dto.costRate !== undefined && money(dto.costRate) !== s.costRate) { s.costRate = money(dto.costRate); changes.push('cost'); }
    if (dto.currency !== undefined) s.currency = (dto.currency || 'INR').toUpperCase();
    if (dto.availableFrom !== undefined) { s.availableFrom = dto.availableFrom || null; changes.push('availability'); }
    if (dto.proposedStart !== undefined) { s.proposedStart = dto.proposedStart || null; changes.push('start date'); }
    if (dto.clientFeedback !== undefined) { s.clientFeedback = dto.clientFeedback?.trim() || null; changes.push('client feedback'); }
    if (dto.ownerId !== undefined) {
      if (dto.ownerId) await this.pipeline.assertMembers(caller.orgId, [dto.ownerId]);
      s.ownerId = dto.ownerId || null;
      changes.push('owner');
    }
    if (dto.sharedDocumentId !== undefined) {
      if (dto.sharedDocumentId) {
        const doc = await this.documents.findOne({ where: { id: dto.sharedDocumentId, candidateId: s.candidateId, organizationId: caller.orgId, isDeleted: false } });
        if (!doc) throw new BadRequestException('That CV does not belong to this candidate');
      }
      s.sharedDocumentId = dto.sharedDocumentId || null;
      changes.push('shared CV');
    }
    await this.submissions.save(s);
    if (changes.length) {
      this.pipeline.audit(caller, 'recruitment.submission_updated', `Updated ${changes.join(', ')} on a submission`, { type: 'lead', id: s.leadId }, { submissionId: s.id });
    }
    return this.get(caller, s.id);
  }

  async remove(caller: RecruitmentCaller, id: string) {
    const s = await this.requireSubmission(caller.orgId, id);
    s.isDeleted = true;
    await this.submissions.save(s);
    const lead = await this.leads.findOne({ where: { id: s.leadId } });
    await this.pipeline.logActivity(caller.orgId, s.candidateId, 'submission', `Removed from ${lead ? lead.company || lead.name : 'client lead'}`, { actorId: caller.userId, meta: { submissionId: s.id } });
    this.pipeline.audit(caller, 'recruitment.submission_deleted', 'Removed a candidate submission', { type: 'lead', id: s.leadId }, { submissionId: s.id });
    return { success: true as const };
  }

  /**
   * Resolve a spreadsheet "Lead" / "Requirement" pair: lead by exact name or company
   * (case-insensitive, open or on-hold first), requirement by title or role within it.
   */
  async findLeadTarget(orgId: string, leadName: string, requirementTitle: string | null) {
    const lead = await this.leads.createQueryBuilder('l')
      .where('l.organization_id = :orgId AND l.is_deleted = false', { orgId })
      .andWhere('(lower(l.name) = lower(:n) OR lower(l.company) = lower(:n))', { n: leadName.trim() })
      .orderBy(`CASE l.status WHEN 'open' THEN 0 WHEN 'on_hold' THEN 1 ELSE 2 END`, 'ASC')
      .addOrderBy('l.updated_at', 'DESC')
      .getOne();
    if (!lead || lead.status === 'lost') return null;
    let req: RequirementEntity | null = null;
    if (requirementTitle) {
      req = await this.requirements.createQueryBuilder('r')
        .where(`r.organization_id = :orgId AND r.entity_type = 'lead' AND r.entity_id = :leadId AND r.is_deleted = false`, { orgId, leadId: lead.id })
        .andWhere('(lower(r.title) = lower(:t) OR lower(r.role) = lower(:t))', { t: requirementTitle.trim() })
        .getOne();
    }
    return { leadId: lead.id, requirementId: req?.id ?? null, label: this.label(lead, req), requirementMissing: !!requirementTitle && !req };
  }

  // ── aggregates used by leads / candidates / analytics ──────────────────────────

  /** status counts per lead and per requirement. */
  async countsFor(orgId: string, leadIds: string[]) {
    if (!leadIds.length) return [] as { leadId: string; requirementId: string | null; status: SubmissionStatus; count: number }[];
    const rows = await this.submissions.createQueryBuilder('s')
      .select('s.lead_id', 'leadId').addSelect('s.requirement_id', 'requirementId').addSelect('s.status', 'status').addSelect('COUNT(*)::int', 'count')
      .where('s.organization_id = :orgId AND s.is_deleted = false AND s.lead_id IN (:...leadIds)', { orgId, leadIds })
      .groupBy('s.lead_id').addGroupBy('s.requirement_id').addGroupBy('s.status')
      .getRawMany<{ leadId: string; requirementId: string | null; status: SubmissionStatus; count: number }>();
    return rows.map((r) => ({ ...r, count: Number(r.count) }));
  }

  /** Short summaries for candidate list rows. */
  async summariesForCandidates(orgId: string, candidateIds: string[]) {
    if (!candidateIds.length) return [];
    const rows = await this.submissions.find({ where: { organizationId: orgId, candidateId: In(candidateIds), isDeleted: false }, order: { updatedAt: 'DESC' } });
    if (!rows.length) return [];
    const leads = await this.leads.find({ where: { id: In([...new Set(rows.map((r) => r.leadId))]) } });
    const reqIds = [...new Set(rows.map((r) => r.requirementId).filter((x): x is string => !!x))];
    const reqs = reqIds.length ? await this.requirements.find({ where: { id: In(reqIds) } }) : [];
    const lById = new Map(leads.map((l) => [l.id, l]));
    const rById = new Map(reqs.map((r) => [r.id, r]));
    return rows.map((s) => ({
      id: s.id, candidateId: s.candidateId, leadId: s.leadId, status: s.status,
      leadName: lById.get(s.leadId)?.company || lById.get(s.leadId)?.name || 'Lead',
      requirementTitle: s.requirementId ? (rById.get(s.requirementId)?.role || rById.get(s.requirementId)?.title || null) : null,
      active: ACTIVE_SUBMISSION_STATUSES.includes(s.status),
    }));
  }

  /** Soft-delete a candidate's submissions (candidate deleted). */
  async removeForCandidate(orgId: string, candidateId: string) {
    await this.submissions.update({ organizationId: orgId, candidateId, isDeleted: false }, { isDeleted: true });
  }
}
