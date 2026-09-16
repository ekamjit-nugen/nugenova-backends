import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { LeadEntity } from '../../sales/entities/lead.entity';
import { RequirementEntity } from '../../sales/entities/requirement.entity';
import { SalesFollowupEntity } from '../../sales/entities/sales-followup.entity';
import { SalesCaller, SalesService } from '../../sales/sales.service';
import { RecruitmentOpeningEntity } from '../entities';
import { ACTIVE_SUBMISSION_STATUSES, SubmissionStatus } from '../submission-rules';
import {
  LeadDocumentDto, LeadFollowupDto, LeadNoteDto, LeadRequirementDto, UpdateLeadFollowupDto, UpdateLeadWorkspaceDto,
} from '../dto';
import { InterviewsService } from './interviews.service';
import { OpeningsService } from './openings.service';
import { PipelineService } from './pipeline.service';
import { SubmissionsService } from './submissions.service';
import { RecruitmentCaller, assertCan, can } from './recruitment-caller';

/** A lead row as returned by SalesService.listLeads / getLead (value as number, owner name resolved). */
type LeadRow = Omit<LeadEntity, 'value'> & { value: number | null; assignedToName: string | null };

const MANUAL_NOTE_TYPES = new Set(['note', 'call', 'email', 'meeting', 'whatsapp', 'visit', 'other']);

/**
 * The Recruitment panel's view of Sales leads (client demand). Reads and edits go
 * through `SalesService` so there is one source of truth; this layer adds the
 * recruitment permission model, the staffing rollups (positions, submissions by
 * status), lead ↔ requirement ownership checks, commercial-field masking and an
 * org audit row for every write.
 */
@Injectable()
export class LeadWorkspaceService {
  constructor(
    @InjectRepository(LeadEntity) private readonly leads: Repository<LeadEntity>,
    @InjectRepository(RequirementEntity) private readonly requirements: Repository<RequirementEntity>,
    @InjectRepository(SalesFollowupEntity) private readonly followups: Repository<SalesFollowupEntity>,
    @InjectRepository(RecruitmentOpeningEntity) private readonly openingRepo: Repository<RecruitmentOpeningEntity>,
    private readonly sales: SalesService,
    private readonly submissions: SubmissionsService,
    private readonly interviews: InterviewsService,
    private readonly openings: OpeningsService,
    private readonly pipeline: PipelineService,
  ) {}

  private salesCaller(c: RecruitmentCaller): SalesCaller {
    return { userId: c.userId, orgId: c.orgId, isAdmin: c.isAdmin };
  }

  private requireLead(orgId: string, id: string) {
    return this.submissions.requireLead(orgId, id);
  }

  private audit(caller: RecruitmentCaller, action: string, summary: string, leadId: string, meta?: Record<string, unknown>) {
    this.pipeline.audit(caller, `recruitment.lead_${action}`, summary, { type: 'lead', id: leadId }, meta);
  }

  private stageMap = async (orgId: string) => new Map((await this.sales.ensureStages(orgId)).map((s) => [s.id, s]));

  // ── list ───────────────────────────────────────────────────────────────────────

  async list(caller: RecruitmentCaller, f: { status?: string; q?: string; ownerId?: string; stageId?: string; hasOpenRequirements?: string }) {
    assertCan(caller, 'view');
    const statuses = f.status ? f.status.split(',') : null;
    const rows = await this.sales.listLeads(caller.orgId, { stageId: f.stageId, assignedTo: f.ownerId, q: f.q });
    // "open" includes on-hold leads — they still carry live client demand.
    const leads = statuses ? rows.filter((l) => statuses.includes(l.status) || (statuses.includes('open') && l.status === 'on_hold')) : rows;
    const { items, stages } = await this.summarize(caller, leads);
    const filtered = f.hasOpenRequirements === '1' ? items.filter((i) => i.requirements.open > 0) : items;
    return { items: filtered, stages };
  }

  /** Staffing rollups for a set of leads (as returned by SalesService, with assignedToName). */
  private async summarize(caller: RecruitmentCaller, leads: LeadRow[]) {
    const ids = leads.map((l) => l.id);
    const [stages, reqs, counts] = await Promise.all([
      this.sales.ensureStages(caller.orgId),
      ids.length ? this.requirements.find({ where: { organizationId: caller.orgId, entityType: 'lead', entityId: In(ids), isDeleted: false }, order: { createdAt: 'ASC' } }) : Promise.resolve([] as RequirementEntity[]),
      this.submissions.countsFor(caller.orgId, ids),
    ]);
    const stageById = new Map(stages.map((s) => [s.id, s]));
    const showMoney = can(caller, 'edit');

    const items = leads.map((l) => {
      const lr = reqs.filter((r) => r.entityId === l.id);
      const openReqs = lr.filter((r) => r.status === 'open' || r.status === 'in_progress');
      const lc = counts.filter((c) => c.leadId === l.id);
      const byStatus: Partial<Record<SubmissionStatus, number>> = {};
      for (const c of lc) byStatus[c.status] = (byStatus[c.status] ?? 0) + c.count;
      const onboardedByReq = (rid: string) => lc.filter((c) => c.requirementId === rid && c.status === 'onboarded').reduce((s, c) => s + c.count, 0);
      const nextNeeded = openReqs.map((r) => r.neededBy).filter((d): d is Date => !!d).sort((a, b) => +new Date(a) - +new Date(b))[0] ?? null;
      const stage = l.stageId ? stageById.get(l.stageId) : null;
      return {
        id: l.id, name: l.name, company: l.company, email: l.email, phone: l.phone, title: l.title,
        stageId: l.stageId, stageName: stage?.name ?? null, stageColor: stage?.color ?? null, status: l.status,
        assignedTo: l.assignedTo, assignedToName: l.assignedToName, tags: l.tags ?? [],
        value: showMoney ? l.value : null, currency: l.currency, valueHidden: !showMoney,
        nextFollowUpAt: l.nextFollowUpAt, lastActivityAt: l.lastActivityAt, clientId: l.clientId, createdAt: l.createdAt, updatedAt: l.updatedAt,
        requirements: {
          total: lr.length, open: openReqs.length, nextNeededBy: nextNeeded,
          positionsOpen: openReqs.reduce((s, r) => s + Math.max((r.positions ?? 1) - onboardedByReq(r.id), 0), 0),
        },
        requirementList: lr.map((r) => ({ id: r.id, title: r.title, role: r.role, status: r.status })),
        submissions: {
          total: lc.reduce((s, c) => s + c.count, 0),
          active: lc.filter((c) => ACTIVE_SUBMISSION_STATUSES.includes(c.status)).reduce((s, c) => s + c.count, 0),
          onboarded: byStatus.onboarded ?? 0,
          byStatus,
        },
      };
    });
    return { items, stages };
  }

  // ── detail ─────────────────────────────────────────────────────────────────────

  async get(caller: RecruitmentCaller, id: string) {
    assertCan(caller, 'view');
    const d = await this.sales.getLead(caller.orgId, id);
    const lead = d.lead as LeadRow;
    const [summary] = (await this.summarize(caller, [lead])).items;
    const [stages, submissions, counts, openings] = await Promise.all([
      this.sales.ensureStages(caller.orgId),
      this.submissions.list(caller, { leadId: id }),
      this.submissions.countsFor(caller.orgId, [id]),
      this.openingRepo.find({ where: { organizationId: caller.orgId, leadId: id, isDeleted: false } }),
    ]);
    const interviews = await this.interviews.listForSubmissions(caller, submissions.map((s) => s.id));
    const names = await this.pipeline.userNames([...d.requirements.map((r) => r.assignedTo), ...d.followups.map((f) => f.assignedTo)]);
    const showMoney = can(caller, 'edit');

    return {
      lead: {
        ...(summary ?? {}),
        id: lead.id, name: lead.name, company: lead.company, email: lead.email, phone: lead.phone, title: lead.title,
        status: lead.status, stageId: lead.stageId, assignedTo: lead.assignedTo, assignedToName: lead.assignedToName, tags: lead.tags ?? [],
        value: showMoney ? lead.value : null, currency: lead.currency, valueHidden: !showMoney,
        notes: lead.notes, requirement: lead.requirement, source: lead.source, sourceDetail: lead.sourceDetail, score: lead.score,
        nextFollowUpAt: lead.nextFollowUpAt, lastActivityAt: lead.lastActivityAt, clientId: lead.clientId, createdAt: lead.createdAt, updatedAt: lead.updatedAt,
      },
      stages: stages.map((s) => ({ id: s.id, name: s.name, color: s.color, order: s.order, isWon: s.isWon, isLost: s.isLost })),
      requirements: d.requirements.map((r) => {
        const rc = counts.filter((c) => c.requirementId === r.id);
        const submissionCounts: Partial<Record<SubmissionStatus, number>> = {};
        for (const c of rc) submissionCounts[c.status] = c.count;
        return {
          ...r, rate: showMoney ? r.rate : null, amount: showMoney ? r.amount : null,
          assignedToName: r.assignedTo ? names.get(r.assignedTo) ?? null : null,
          submissionCounts, onboarded: submissionCounts.onboarded ?? 0,
          activeSubmissions: rc.filter((c) => ACTIVE_SUBMISSION_STATUSES.includes(c.status)).reduce((s, c) => s + c.count, 0),
        };
      }),
      submissions,
      interviews,
      followups: d.followups.map((f) => ({ ...f, assignedToName: f.assignedTo ? names.get(f.assignedTo) ?? null : null })),
      notes: d.activities.filter((a) => MANUAL_NOTE_TYPES.has(a.type)),
      documents: d.documents,
      openings: openings.map((o) => ({ id: o.id, title: o.title, status: o.status, requirementId: o.requirementId })),
    };
  }

  // ── lead edits ─────────────────────────────────────────────────────────────────

  async update(caller: RecruitmentCaller, id: string, dto: UpdateLeadWorkspaceDto) {
    await this.requireLead(caller.orgId, id);
    if (dto.assignedTo) await this.pipeline.assertMembers(caller.orgId, [dto.assignedTo]);
    const patch: Record<string, unknown> = {};
    for (const k of ['name', 'company', 'email', 'phone', 'title', 'tags', 'notes', 'requirement', 'status'] as const) {
      if (dto[k] !== undefined) patch[k] = dto[k] ?? (k === 'tags' ? [] : null);
    }
    if (dto.assignedTo !== undefined) patch.assignedTo = dto.assignedTo || '';
    if (dto.value !== undefined) patch.value = dto.value;
    if (patch.name !== undefined && !String(patch.name).trim()) throw new BadRequestException('Lead name is required');
    await this.sales.updateLead(this.salesCaller(caller), id, patch as any);
    this.audit(caller, 'updated', `Updated lead details (${Object.keys(patch).join(', ')})`, id);
    return this.get(caller, id);
  }

  async move(caller: RecruitmentCaller, id: string, stageId: string) {
    await this.requireLead(caller.orgId, id);
    const stages = await this.stageMap(caller.orgId);
    const stage = stages.get(stageId);
    if (!stage) throw new BadRequestException('Stage not found');
    await this.sales.moveStage(this.salesCaller(caller), id, { stageId });
    this.audit(caller, 'moved', `Moved lead to ${stage.name}`, id, { stageId });
    return this.get(caller, id);
  }

  // ── requirements ───────────────────────────────────────────────────────────────

  private async requireRequirement(orgId: string, leadId: string, reqId: string) {
    return this.submissions.requireRequirement(orgId, leadId, reqId);
  }

  async addRequirement(caller: RecruitmentCaller, leadId: string, dto: LeadRequirementDto) {
    await this.requireLead(caller.orgId, leadId);
    if (dto.assignedTo) await this.pipeline.assertMembers(caller.orgId, [dto.assignedTo]);
    const title = dto.title?.trim() || dto.role?.trim();
    if (!title) throw new BadRequestException('Give the requirement a title or role');
    const r = await this.sales.addRequirement(this.salesCaller(caller), 'lead', leadId, {
      ...dto, title, details: dto.details ?? undefined, role: dto.role ?? undefined, neededBy: dto.neededBy ?? undefined,
      assignedTo: dto.assignedTo ?? undefined, positions: dto.positions ?? undefined,
    } as any);
    this.audit(caller, 'requirement_added', `Added requirement “${title}”`, leadId, { requirementId: r.id });
    return r;
  }

  async updateRequirement(caller: RecruitmentCaller, leadId: string, reqId: string, dto: LeadRequirementDto) {
    await this.requireRequirement(caller.orgId, leadId, reqId);
    if (dto.assignedTo) await this.pipeline.assertMembers(caller.orgId, [dto.assignedTo]);
    const r = await this.sales.updateRequirement(caller.orgId, reqId, dto as any);
    this.audit(caller, 'requirement_updated', `Updated requirement “${r.title}”`, leadId, { requirementId: reqId, fields: Object.keys(dto) });
    return r;
  }

  async deleteRequirement(caller: RecruitmentCaller, leadId: string, reqId: string) {
    const r = await this.requireRequirement(caller.orgId, leadId, reqId);
    const active = (await this.submissions.countsFor(caller.orgId, [leadId]))
      .filter((c) => c.requirementId === reqId && ACTIVE_SUBMISSION_STATUSES.includes(c.status)).reduce((s, c) => s + c.count, 0);
    if (active) throw new BadRequestException(`${active} candidate(s) are still active on this requirement — close or withdraw them first, or mark the requirement dropped`);
    await this.sales.deleteRequirement(caller.orgId, reqId);
    this.audit(caller, 'requirement_deleted', `Deleted requirement “${r.title}”`, leadId, { requirementId: reqId });
    return { success: true as const };
  }

  async openingFromRequirement(caller: RecruitmentCaller, leadId: string, reqId: string) {
    assertCan(caller, 'create');
    const lead = await this.requireLead(caller.orgId, leadId);
    const r = await this.requireRequirement(caller.orgId, leadId, reqId);
    const existing = await this.openingRepo.findOne({ where: { organizationId: caller.orgId, requirementId: reqId, isDeleted: false } });
    if (existing) throw new ConflictException({ code: 'OPENING_EXISTS', message: `“${existing.title}” is already open for this requirement`, openingId: existing.id });
    const details = (r.details ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const opening = await this.openings.create(caller, {
      title: `${r.role || r.title}${lead.company ? ` (${lead.company})` : ''}`.slice(0, 200),
      skills: r.skills ?? [], positions: r.positions ?? 1,
      targetDate: r.neededBy ? new Date(r.neededBy).toISOString().slice(0, 10) : undefined,
      description: [details, `Client requirement: ${lead.company || lead.name} — ${r.title}`].filter(Boolean).join('\n\n'),
      recruiterIds: r.assignedTo ? [r.assignedTo] : [],
    });
    await this.openingRepo.update({ id: opening.id }, { leadId, requirementId: reqId });
    this.audit(caller, 'opening_created', `Opened “${opening.title}” from a client requirement`, leadId, { requirementId: reqId, openingId: opening.id });
    return { ...opening, leadId, requirementId: reqId };
  }

  // ── follow-ups, notes, documents ───────────────────────────────────────────────

  async addFollowup(caller: RecruitmentCaller, leadId: string, dto: LeadFollowupDto) {
    await this.requireLead(caller.orgId, leadId);
    if (dto.assignedTo) await this.pipeline.assertMembers(caller.orgId, [dto.assignedTo]);
    const f = await this.sales.addFollowup(this.salesCaller(caller), 'lead', leadId, dto);
    this.audit(caller, 'followup_added', `Scheduled a follow-up for ${new Date(dto.dueAt).toLocaleDateString('en-IN')}`, leadId, { followupId: f.id });
    return f;
  }

  async updateFollowup(caller: RecruitmentCaller, leadId: string, id: string, dto: UpdateLeadFollowupDto) {
    const f = await this.followups.findOne({ where: { id, organizationId: caller.orgId, entityType: 'lead', entityId: leadId, isDeleted: false } });
    if (!f) throw new NotFoundException('Follow-up not found on this lead');
    const saved = await this.sales.updateFollowup(caller.orgId, id, dto);
    if (dto.status === 'done') this.audit(caller, 'followup_done', 'Completed a follow-up', leadId, { followupId: id });
    return saved;
  }

  async addNote(caller: RecruitmentCaller, leadId: string, dto: LeadNoteDto) {
    await this.requireLead(caller.orgId, leadId);
    return this.sales.addActivity(this.salesCaller(caller), 'lead', leadId, { type: dto.type, body: dto.body.trim() });
  }

  async addDocument(caller: RecruitmentCaller, leadId: string, dto: LeadDocumentDto) {
    const doc = await this.sales.addDocument(this.salesCaller(caller), leadId, dto);
    this.audit(caller, 'document_added', `Attached ${dto.fileName}`, leadId);
    return doc;
  }

  async removeDocument(caller: RecruitmentCaller, leadId: string, docId: string) {
    await this.requireLead(caller.orgId, leadId);
    const res = await this.sales.removeDocument(caller.orgId, leadId, docId);
    this.audit(caller, 'document_removed', 'Removed a lead document', leadId);
    return res;
  }
}
