import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, ILike, In, Repository } from 'typeorm';

import { PipelineStageEntity } from './entities/pipeline-stage.entity';
import { LeadEntity } from './entities/lead.entity';
import { SalesAccountEntity } from './entities/sales-account.entity';
import { SalesContactEntity } from './entities/sales-contact.entity';
import { SalesActivityEntity } from './entities/sales-activity.entity';
import { SalesFollowupEntity } from './entities/sales-followup.entity';
import { RequirementEntity } from './entities/requirement.entity';
import { QuoteEntity, QuoteItem } from './entities/quote.entity';
import { LeadDocumentEntity } from './entities/lead-document.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { ClientEntity } from '../clients/entities/client.entity';
import { NotifierService } from '../notification/notifier.service';
import { ClientsService } from '../clients/clients.service';
import { DEFAULT_STAGES, LEAD_SOURCE_FIELDS, LeadSource, SalesEntityType } from './sales.constants';
import { EMAIL_OVERRIDES } from '../notification/notification-catalog';
import {
  CreateAccountDto, CreateActivityDto, CreateContactDto, CreateFollowupDto, CreateLeadDto, CreateLeadDocumentDto,
  CreateQuoteDto, CreateRequirementDto, CreateStageDto, MoveStageDto, UpdateAccountDto, UpdateContactDto,
  UpdateFollowupDto, UpdateLeadDto, UpdateQuoteDto, UpdateRequirementDto,
} from './dto';

export interface SalesCaller { userId: string; orgId: string; isAdmin: boolean }

const nameOf = (u?: UserEntity | null): string =>
  u ? `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email || 'Member' : 'Member';

@Injectable()
export class SalesService {
  constructor(
    @InjectRepository(PipelineStageEntity) private readonly stages: Repository<PipelineStageEntity>,
    @InjectRepository(LeadEntity) private readonly leads: Repository<LeadEntity>,
    @InjectRepository(SalesAccountEntity) private readonly accounts: Repository<SalesAccountEntity>,
    @InjectRepository(SalesContactEntity) private readonly contacts: Repository<SalesContactEntity>,
    @InjectRepository(SalesActivityEntity) private readonly activities: Repository<SalesActivityEntity>,
    @InjectRepository(SalesFollowupEntity) private readonly followups: Repository<SalesFollowupEntity>,
    @InjectRepository(RequirementEntity) private readonly requirements: Repository<RequirementEntity>,
    @InjectRepository(QuoteEntity) private readonly quotes: Repository<QuoteEntity>,
    @InjectRepository(LeadDocumentEntity) private readonly leadDocuments: Repository<LeadDocumentEntity>,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(ClientEntity) private readonly clientRecords: Repository<ClientEntity>,
    private readonly clientsService: ClientsService,
    @Optional() private readonly notifier?: NotifierService,
  ) {}

  // ── pipeline stages ──────────────────────────────────────────────────────────

  /** Seed the default funnel the first time an org touches sales. */
  async ensureStages(orgId: string): Promise<PipelineStageEntity[]> {
    const existing = await this.stages.find({ where: { organizationId: orgId, isDeleted: false }, order: { order: 'ASC' } });
    if (existing.length) return existing;
    await this.stages.save(DEFAULT_STAGES.map((s) => this.stages.create({ organizationId: orgId, ...s, createdBy: null, isDeleted: false })));
    return this.stages.find({ where: { organizationId: orgId, isDeleted: false }, order: { order: 'ASC' } });
  }

  listStages(orgId: string) { return this.ensureStages(orgId); }

  async createStage(caller: SalesCaller, dto: CreateStageDto): Promise<PipelineStageEntity> {
    const all = await this.ensureStages(caller.orgId);
    const order = dto.order ?? (Math.max(0, ...all.map((s) => s.order)) + 1);
    return this.stages.save(this.stages.create({
      organizationId: caller.orgId, name: dto.name.trim(), order,
      probability: dto.probability ?? 0, color: dto.color ?? null,
      isWon: dto.isWon ?? false, isLost: dto.isLost ?? false, isDefault: false, createdBy: caller.userId, isDeleted: false,
    }));
  }

  // ── leads ────────────────────────────────────────────────────────────────────

  private async requireLead(orgId: string, id: string): Promise<LeadEntity> {
    const l = await this.leads.findOne({ where: { id, organizationId: orgId, isDeleted: false } });
    if (!l) throw new NotFoundException('Lead not found');
    return l;
  }

  async listLeads(orgId: string, f: { status?: string; stageId?: string; assignedTo?: string; source?: string; q?: string }) {
    const qb = this.leads.createQueryBuilder('l')
      .where('l.organization_id = :orgId AND l.is_deleted = false', { orgId });
    if (f.status) qb.andWhere('l.status = :status', { status: f.status });
    if (f.stageId) qb.andWhere('l.stage_id = :stageId', { stageId: f.stageId });
    if (f.assignedTo) qb.andWhere('l.assigned_to = :assignedTo', { assignedTo: f.assignedTo });
    if (f.source) qb.andWhere('l.source = :source', { source: f.source });
    if (f.q) qb.andWhere(new Brackets((b) => b.where('l.name ILIKE :q', { q: `%${f.q}%` }).orWhere('l.company ILIKE :q', { q: `%${f.q}%` }).orWhere('l.email ILIKE :q', { q: `%${f.q}%` })));
    const rows = await qb.orderBy('l.updated_at', 'DESC').take(500).getMany();
    return this.withNames(rows);
  }

  /** Kanban: stages + leads (open by default), for grouping client-side. */
  async board(orgId: string, includeClosed = false) {
    const stages = await this.ensureStages(orgId);
    const where: Record<string, unknown> = { organizationId: orgId, isDeleted: false };
    if (!includeClosed) where.status = 'open';
    const rows = await this.leads.find({ where, order: { updatedAt: 'DESC' } });
    return { stages, leads: await this.withNames(rows) };
  }

  async getLead(orgId: string, id: string) {
    const lead = await this.requireLead(orgId, id);
    const [stage, activities, followups, requirements, documents] = await Promise.all([
      lead.stageId ? this.stages.findOne({ where: { id: lead.stageId } }) : null,
      this.activities.find({ where: { organizationId: orgId, entityType: 'lead', entityId: id, isDeleted: false }, order: { occurredAt: 'DESC' } }),
      this.followups.find({ where: { organizationId: orgId, entityType: 'lead', entityId: id, isDeleted: false }, order: { dueAt: 'ASC' } }),
      this.requirements.find({ where: { organizationId: orgId, entityType: 'lead', entityId: id, isDeleted: false }, order: { createdAt: 'ASC' } }),
      this.leadDocuments.find({ where: { organizationId: orgId, leadId: id, isDeleted: false }, order: { createdAt: 'DESC' } }),
    ]);
    const [withName] = await this.withNames([lead]);
    return {
      lead: withName, stage, activities, followups,
      requirements: requirements.map((r) => this.requirementView(r)), effort: this.rollupEffort(requirements),
      documents: documents.map((d) => this.documentView(d)),
    };
  }

  async createLead(caller: SalesCaller, dto: CreateLeadDto): Promise<LeadEntity> {
    const source = dto.source ?? 'other';
    const client = await this.findSourceClient(caller.orgId, source, dto.sourceClientId);
    // A client-sourced lead needs no separate contact: fall back to the client's record.
    const contact = client?.primaryContact ?? null;
    const name = dto.name?.trim() || contact?.name?.trim() || (client ? client.displayName || client.companyName : '');
    if (!name) throw new BadRequestException('Contact name is required');
    const stages = await this.ensureStages(caller.orgId);
    const stageId = dto.stageId || stages.find((s) => s.isDefault)?.id || stages[0]?.id || null;
    const lead = await this.leads.save(this.leads.create({
      organizationId: caller.orgId,
      name,
      company: dto.company ?? (client ? client.displayName || client.companyName : null),
      email: (dto.email ?? contact?.email)?.toLowerCase() ?? null,
      phone: dto.phone ?? contact?.phone ?? null,
      title: dto.title ?? contact?.designation ?? null,
      source: source as any,
      sourceDetail: source === 'other' ? (dto.sourceDetail?.trim() || null) : null,
      sourceClientId: client?.id ?? null,
      sourceMeta: this.cleanSourceMeta(source, dto.sourceMeta),
      stageId, status: 'open',
      value: dto.value != null ? String(dto.value) : null, currency: dto.currency?.toUpperCase() ?? 'INR',
      requirement: dto.requirement ?? null,
      assignedTo: dto.assignedTo ?? null, score: dto.score ?? 0, tags: dto.tags ?? [], notes: dto.notes ?? null,
      createdBy: caller.userId, isDeleted: false,
    }));
    if (dto.assignedTo && dto.assignedTo !== caller.userId) this.notifyAssignment(caller.orgId, dto.assignedTo, lead, caller.userId);
    return lead;
  }

  async updateLead(caller: SalesCaller, id: string, dto: UpdateLeadDto): Promise<LeadEntity> {
    const l = await this.requireLead(caller.orgId, id);
    const prevAssignee = l.assignedTo;
    const prevSource = l.source;
    if (dto.name !== undefined) l.name = dto.name.trim();
    if (dto.company !== undefined) l.company = dto.company;
    if (dto.email !== undefined) l.email = dto.email?.toLowerCase() ?? null;
    if (dto.phone !== undefined) l.phone = dto.phone;
    if (dto.title !== undefined) l.title = dto.title;
    if (dto.sourceDetail !== undefined) l.sourceDetail = dto.sourceDetail?.trim() || null;
    if (dto.source !== undefined) { l.source = dto.source as any; if (dto.source !== 'other') l.sourceDetail = null; }
    if (dto.source !== undefined || dto.sourceMeta !== undefined) {
      // A new source starts with a clean slate unless its details come along in the same update.
      const meta = dto.sourceMeta !== undefined ? dto.sourceMeta : dto.source !== undefined && dto.source !== prevSource ? null : l.sourceMeta;
      l.sourceMeta = this.cleanSourceMeta(l.source, meta);
    }
    if (dto.source !== undefined || dto.sourceClientId !== undefined) {
      l.sourceClientId = await this.resolveSourceClient(caller.orgId, l.source, dto.sourceClientId !== undefined ? dto.sourceClientId : l.sourceClientId);
    }
    if (dto.status !== undefined) l.status = dto.status as any;
    if (dto.value !== undefined) l.value = dto.value != null ? String(dto.value) : null;
    if (dto.currency !== undefined) l.currency = dto.currency.toUpperCase();
    if (dto.requirement !== undefined) l.requirement = dto.requirement;
    if (dto.assignedTo !== undefined) l.assignedTo = dto.assignedTo || null;
    if (dto.score !== undefined) l.score = dto.score;
    if (dto.tags !== undefined) l.tags = dto.tags;
    if (dto.notes !== undefined) l.notes = dto.notes;
    if (dto.status !== undefined) l.wonAt = dto.status === 'won' ? (l.wonAt ?? new Date()) : null;
    if (dto.stageId !== undefined && dto.stageId !== l.stageId) return this.moveStage(caller, id, { stageId: dto.stageId });
    const saved = await this.leads.save(l);
    if (dto.assignedTo && dto.assignedTo !== prevAssignee && dto.assignedTo !== caller.userId) this.notifyAssignment(caller.orgId, dto.assignedTo, saved, caller.userId);
    return saved;
  }

  /** Move a lead to another stage; won/lost stages set the lead status. */
  async moveStage(caller: SalesCaller, id: string, dto: MoveStageDto): Promise<LeadEntity> {
    const l = await this.requireLead(caller.orgId, id);
    const stage = await this.stages.findOne({ where: { id: dto.stageId, organizationId: caller.orgId, isDeleted: false } });
    if (!stage) throw new BadRequestException('Stage not found');
    l.stageId = stage.id;
    l.status = stage.isWon ? 'won' : stage.isLost ? 'lost' : 'open';
    l.wonAt = stage.isWon ? (l.wonAt ?? new Date()) : null;
    return this.leads.save(l);
  }

  async deleteLead(orgId: string, id: string): Promise<{ success: true }> {
    const l = await this.requireLead(orgId, id);
    l.isDeleted = true;
    await this.leads.save(l);
    return { success: true };
  }

  // ── activities + follow-ups ──────────────────────────────────────────────────

  async addActivity(caller: SalesCaller, entityType: SalesEntityType, entityId: string, dto: CreateActivityDto) {
    const user = await this.users.findOne({ where: { id: caller.userId } });
    const a = await this.activities.save(this.activities.create({
      organizationId: caller.orgId, entityType, entityId, type: dto.type as any,
      typeDetail: dto.type === 'other' ? (dto.typeDetail?.trim() || null) : null, body: dto.body ?? null,
      occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : new Date(), createdBy: caller.userId, createdByName: nameOf(user), isDeleted: false,
    }));
    await this.touchEntity(caller.orgId, entityType, entityId);
    return a;
  }

  private async touchEntity(orgId: string, entityType: SalesEntityType, entityId: string) {
    const now = new Date();
    if (entityType === 'lead') await this.leads.update({ id: entityId, organizationId: orgId }, { lastActivityAt: now });
    else if (entityType === 'account') await this.accounts.update({ id: entityId, organizationId: orgId }, { lastActivityAt: now });
    else if (entityType === 'contact') await this.contacts.update({ id: entityId, organizationId: orgId }, { lastActivityAt: now });
  }

  /** Set a lead's value from its requirements' rolled-up estimate. */
  async rollupLeadValue(caller: SalesCaller, id: string) {
    const l = await this.requireLead(caller.orgId, id);
    const reqs = await this.requirements.find({ where: { organizationId: caller.orgId, entityType: 'lead', entityId: id, isDeleted: false } });
    l.value = String(this.rollupEffort(reqs).totalAmount);
    const [withName] = await this.withNames([await this.leads.save(l)]);
    return withName;
  }

  // ── lead documents (briefs, specs, contracts) ───────────────────────────────────

  private documentView(d: LeadDocumentEntity) {
    return {
      id: d.id, leadId: d.leadId, fileId: d.fileId, name: d.title || d.fileName, fileName: d.fileName,
      mimeType: d.mimeType, size: d.size != null ? Number(d.size) : null, createdAt: d.createdAt,
    };
  }

  async listDocuments(orgId: string, leadId: string) {
    await this.requireLead(orgId, leadId);
    const rows = await this.leadDocuments.find({ where: { organizationId: orgId, leadId, isDeleted: false }, order: { createdAt: 'DESC' } });
    return rows.map((d) => this.documentView(d));
  }

  async addDocument(caller: SalesCaller, leadId: string, dto: CreateLeadDocumentDto) {
    await this.requireLead(caller.orgId, leadId);
    const saved = await this.leadDocuments.save(this.leadDocuments.create({
      organizationId: caller.orgId, leadId, fileId: dto.fileId, fileName: dto.fileName,
      mimeType: dto.mimeType ?? null, size: dto.size ?? null, title: dto.title?.trim() || null,
      createdBy: caller.userId, isDeleted: false,
    }));
    return this.documentView(saved);
  }

  async removeDocument(orgId: string, leadId: string, docId: string) {
    const d = await this.leadDocuments.findOne({ where: { id: docId, leadId, organizationId: orgId, isDeleted: false } });
    if (!d) throw new NotFoundException('Document not found');
    d.isDeleted = true;
    await this.leadDocuments.save(d);
    return { success: true as const };
  }

  // ── requirements (effort estimation) ───────────────────────────────────────────

  private requirementView(r: RequirementEntity) {
    const quantity = Number(r.quantity ?? 0);
    const rate = Number(r.rate ?? 0);
    return {
      id: r.id, entityType: r.entityType, entityId: r.entityId, title: r.title, details: r.details, category: r.category,
      role: r.role, skills: r.skills ?? [], priority: r.priority, priorityDetail: r.priorityDetail, status: r.status, unit: r.unit, unitDetail: r.unitDetail,
      quantity, rate, amount: quantity * rate, neededBy: r.neededBy, assignedTo: r.assignedTo, positions: r.positions ?? null, createdAt: r.createdAt,
    };
  }

  private rollupEffort(reqs: RequirementEntity[]) {
    let totalHours = 0, totalDays = 0, totalAmount = 0;
    for (const r of reqs) {
      if (r.status === 'dropped') continue;
      const qty = Number(r.quantity ?? 0);
      const rate = Number(r.rate ?? 0);
      totalAmount += qty * rate;
      if (r.unit === 'hours') totalHours += qty;
      else if (r.unit === 'days') totalDays += qty;
    }
    return { totalHours, totalDays, totalAmount, count: reqs.length };
  }

  async listRequirements(orgId: string, entityType: SalesEntityType, entityId: string) {
    const rows = await this.requirements.find({ where: { organizationId: orgId, entityType, entityId, isDeleted: false }, order: { createdAt: 'ASC' } });
    return { requirements: rows.map((r) => this.requirementView(r)), effort: this.rollupEffort(rows) };
  }

  async addRequirement(caller: SalesCaller, entityType: SalesEntityType, entityId: string, dto: CreateRequirementDto) {
    const r = await this.requirements.save(this.requirements.create({
      organizationId: caller.orgId, entityType, entityId, title: dto.title.trim(), details: dto.details ?? null,
      category: dto.category ?? null, role: dto.role ?? null, skills: dto.skills ?? [],
      priority: dto.priority ?? 'must_have',
      priorityDetail: (dto.priority ?? 'must_have') === 'other' ? (dto.priorityDetail?.trim() || null) : null,
      status: dto.status ?? 'open', unit: dto.unit ?? 'hours',
      unitDetail: (dto.unit ?? 'hours') === 'other' ? (dto.unitDetail?.trim() || null) : null,
      quantity: String(dto.quantity ?? 0), rate: String(dto.rate ?? 0),
      neededBy: dto.neededBy ? new Date(dto.neededBy) : null, assignedTo: dto.assignedTo ?? null, positions: dto.positions ?? null,
      createdBy: caller.userId, isDeleted: false,
    }));
    return this.requirementView(r);
  }

  async updateRequirement(orgId: string, id: string, dto: UpdateRequirementDto) {
    const r = await this.requirements.findOne({ where: { id, organizationId: orgId, isDeleted: false } });
    if (!r) throw new NotFoundException('Requirement not found');
    if (dto.title !== undefined) r.title = dto.title.trim();
    if (dto.details !== undefined) r.details = dto.details;
    if (dto.category !== undefined) r.category = dto.category;
    if (dto.role !== undefined) r.role = dto.role;
    if (dto.skills !== undefined) r.skills = dto.skills;
    if (dto.priorityDetail !== undefined) r.priorityDetail = dto.priorityDetail?.trim() || null;
    if (dto.priority !== undefined) { r.priority = dto.priority; if (dto.priority !== 'other') r.priorityDetail = null; }
    if (dto.status !== undefined) r.status = dto.status;
    if (dto.unitDetail !== undefined) r.unitDetail = dto.unitDetail?.trim() || null;
    if (dto.unit !== undefined) { r.unit = dto.unit; if (dto.unit !== 'other') r.unitDetail = null; }
    if (dto.quantity !== undefined) r.quantity = String(dto.quantity);
    if (dto.rate !== undefined) r.rate = String(dto.rate);
    if (dto.neededBy !== undefined) r.neededBy = dto.neededBy ? new Date(dto.neededBy) : null;
    if (dto.assignedTo !== undefined) r.assignedTo = dto.assignedTo || null;
    if (dto.positions !== undefined) r.positions = dto.positions ?? null;
    return this.requirementView(await this.requirements.save(r));
  }

  async deleteRequirement(orgId: string, id: string) {
    await this.requirements.update({ id, organizationId: orgId }, { isDeleted: true });
    return { success: true as const };
  }

  async addFollowup(caller: SalesCaller, entityType: SalesEntityType, entityId: string, dto: CreateFollowupDto) {
    const f = await this.followups.save(this.followups.create({
      organizationId: caller.orgId, entityType, entityId, dueAt: new Date(dto.dueAt), note: dto.note?.trim() || null,
      waitingOn: (dto.waitingOn as any) ?? null,
      status: 'pending', assignedTo: dto.assignedTo ?? caller.userId, createdBy: caller.userId, isDeleted: false,
    }));
    if (entityType === 'lead') await this.syncNextFollowUp(caller.orgId, entityId);
    return f;
  }

  async updateFollowup(orgId: string, id: string, dto: UpdateFollowupDto) {
    const f = await this.followups.findOne({ where: { id, organizationId: orgId, isDeleted: false } });
    if (!f) throw new NotFoundException('Follow-up not found');
    if (dto.status !== undefined) { f.status = dto.status as any; f.completedAt = dto.status === 'done' ? (f.completedAt ?? new Date()) : null; }
    if (dto.dueAt !== undefined) f.dueAt = new Date(dto.dueAt);
    if (dto.note !== undefined) f.note = dto.note?.trim() || null;
    if (dto.waitingOn !== undefined) f.waitingOn = (dto.waitingOn as any) || null;
    const saved = await this.followups.save(f);
    if (f.entityType === 'lead') await this.syncNextFollowUp(orgId, f.entityId);
    return saved;
  }

  /** A lead's `nextFollowUpAt` = its soonest still-open follow-up (null when none). */
  private async syncNextFollowUp(orgId: string, leadId: string) {
    const next = await this.followups.findOne({
      where: { organizationId: orgId, entityType: 'lead', entityId: leadId, isDeleted: false, status: In(['pending', 'snoozed']) },
      order: { dueAt: 'ASC' },
    });
    await this.leads.update({ id: leadId, organizationId: orgId }, { nextFollowUpAt: next?.dueAt ?? null });
  }

  /** Open follow-ups for the org (optionally only the caller's), soonest first. */
  async listFollowups(orgId: string, assignedTo?: string) {
    const where: Record<string, unknown> = { organizationId: orgId, isDeleted: false, status: In(['pending', 'snoozed']) };
    if (assignedTo) where.assignedTo = assignedTo;
    return this.followups.find({ where, order: { dueAt: 'ASC' }, take: 200 });
  }

  // ── quotes / proposals ─────────────────────────────────────────────────────────

  private computeQuote(items: QuoteItem[], discountType: string, discountValue: number, taxPercent: number) {
    const subtotal = items.reduce((s, i) => s + (Number(i.quantity) || 0) * (Number(i.rate) || 0), 0);
    const discountAmount = discountType === 'amount' ? Math.min(discountValue, subtotal) : subtotal * (discountValue / 100);
    const afterDiscount = Math.max(0, subtotal - discountAmount);
    const taxAmount = afterDiscount * (taxPercent / 100);
    return { subtotal, discountAmount, taxAmount, total: afterDiscount + taxAmount };
  }

  private quoteView(q: QuoteEntity) {
    return {
      id: q.id, entityType: q.entityType, entityId: q.entityId, number: q.number, title: q.title, status: q.status,
      currency: q.currency, items: q.items ?? [], discountType: q.discountType, discountValue: Number(q.discountValue),
      taxPercent: Number(q.taxPercent), notes: q.notes,
      subtotal: Number(q.subtotal), discountAmount: Number(q.discountAmount), taxAmount: Number(q.taxAmount), total: Number(q.total),
      validUntil: q.validUntil, sentAt: q.sentAt, acceptedAt: q.acceptedAt, rejectedAt: q.rejectedAt, createdAt: q.createdAt,
    };
  }

  async listQuotes(orgId: string, entityType: SalesEntityType, entityId: string) {
    const rows = await this.quotes.find({ where: { organizationId: orgId, entityType, entityId, isDeleted: false }, order: { createdAt: 'DESC' } });
    return rows.map((q) => this.quoteView(q));
  }

  async getQuote(orgId: string, id: string) {
    const q = await this.quotes.findOne({ where: { id, organizationId: orgId, isDeleted: false } });
    if (!q) throw new NotFoundException('Quote not found');
    return this.quoteView(q);
  }

  private async nextQuoteNumber(orgId: string): Promise<string> {
    const count = await this.quotes.count({ where: { organizationId: orgId } });
    return `Q-${String(count + 1).padStart(4, '0')}`;
  }

  async createQuote(caller: SalesCaller, entityType: SalesEntityType, entityId: string, dto: CreateQuoteDto) {
    const items = (dto.items ?? []).map((i) => ({ description: i.description, unit: i.unit ?? 'fixed', quantity: Number(i.quantity) || 0, rate: Number(i.rate) || 0 }));
    const t = this.computeQuote(items, dto.discountType ?? 'percent', dto.discountValue ?? 0, dto.taxPercent ?? 0);
    const q = await this.quotes.save(this.quotes.create({
      organizationId: caller.orgId, entityType, entityId, number: await this.nextQuoteNumber(caller.orgId),
      title: dto.title?.trim() || 'Quote', status: 'draft', currency: dto.currency?.toUpperCase() ?? 'INR', items,
      discountType: dto.discountType ?? 'percent', discountValue: String(dto.discountValue ?? 0), taxPercent: String(dto.taxPercent ?? 0),
      notes: dto.notes ?? null, subtotal: String(t.subtotal), discountAmount: String(t.discountAmount), taxAmount: String(t.taxAmount),
      total: String(t.total), validUntil: dto.validUntil ? new Date(dto.validUntil) : null, createdBy: caller.userId, isDeleted: false,
    }));
    return this.quoteView(q);
  }

  /** Build a draft quote from an entity's (non-dropped) requirements. */
  async quoteFromRequirements(caller: SalesCaller, entityType: SalesEntityType, entityId: string) {
    const reqs = await this.requirements.find({ where: { organizationId: caller.orgId, entityType, entityId, isDeleted: false } });
    const items: QuoteItem[] = reqs.filter((r) => r.status !== 'dropped').map((r) => ({
      description: r.role ? `${r.title} (${r.role})` : r.title,
      unit: ['hours', 'days', 'fixed'].includes(r.unit) ? r.unit : 'unit', quantity: Number(r.quantity) || 0, rate: Number(r.rate) || 0,
    }));
    return this.createQuote(caller, entityType, entityId, { title: 'Proposal', items });
  }

  async updateQuote(orgId: string, id: string, dto: UpdateQuoteDto) {
    const q = await this.quotes.findOne({ where: { id, organizationId: orgId, isDeleted: false } });
    if (!q) throw new NotFoundException('Quote not found');
    if (dto.title !== undefined) q.title = dto.title.trim();
    if (dto.currency !== undefined) q.currency = dto.currency.toUpperCase();
    if (dto.items !== undefined) q.items = dto.items.map((i) => ({ description: i.description, unit: i.unit ?? 'fixed', quantity: Number(i.quantity) || 0, rate: Number(i.rate) || 0 }));
    if (dto.discountType !== undefined) q.discountType = dto.discountType;
    if (dto.discountValue !== undefined) q.discountValue = String(dto.discountValue);
    if (dto.taxPercent !== undefined) q.taxPercent = String(dto.taxPercent);
    if (dto.notes !== undefined) q.notes = dto.notes;
    if (dto.validUntil !== undefined) q.validUntil = dto.validUntil ? new Date(dto.validUntil) : null;
    if (dto.status !== undefined) this.applyQuoteStatus(q, dto.status);
    const t = this.computeQuote(q.items, q.discountType, Number(q.discountValue), Number(q.taxPercent));
    q.subtotal = String(t.subtotal); q.discountAmount = String(t.discountAmount); q.taxAmount = String(t.taxAmount); q.total = String(t.total);
    return this.quoteView(await this.quotes.save(q));
  }

  private applyQuoteStatus(q: QuoteEntity, status: string) {
    q.status = status as any;
    const now = new Date();
    if (status === 'sent' && !q.sentAt) q.sentAt = now;
    if (status === 'accepted') q.acceptedAt = now;
    if (status === 'rejected') q.rejectedAt = now;
  }

  async setQuoteStatus(orgId: string, id: string, status: 'sent' | 'accepted' | 'rejected') {
    const q = await this.quotes.findOne({ where: { id, organizationId: orgId, isDeleted: false } });
    if (!q) throw new NotFoundException('Quote not found');
    this.applyQuoteStatus(q, status);
    return this.quoteView(await this.quotes.save(q));
  }

  async deleteQuote(orgId: string, id: string) {
    await this.quotes.update({ id, organizationId: orgId }, { isDeleted: true });
    return { success: true as const };
  }

  // ── won lead → client (bridge to the delivery Clients module) ───────────────────

  async convertLeadToClient(caller: SalesCaller, leadId: string) {
    const lead = await this.requireLead(caller.orgId, leadId);
    if (lead.clientId) throw new BadRequestException('This lead is already linked to a client');
    const companyName = lead.company || lead.name;
    const client = await this.clientsService.create(
      { userId: caller.userId, orgId: caller.orgId, isAdmin: caller.isAdmin },
      {
        companyName,
        notes: `Created from won lead "${lead.name}"${lead.value ? ` (${lead.currency} ${Number(lead.value)})` : ''}.`,
        primaryContact: (lead.email || lead.phone || lead.title)
          ? { name: lead.name, email: lead.email ?? undefined, phone: lead.phone ?? undefined, designation: lead.title ?? undefined }
          : undefined,
      } as any,
    );
    lead.clientId = client.id;
    await this.leads.save(lead);
    return { clientId: client.id, leadId };
  }

  // ── accounts + contacts ──────────────────────────────────────────────────────

  listAccounts(orgId: string, q?: string) {
    const where: Record<string, unknown> = { organizationId: orgId, isDeleted: false };
    if (q) where.name = ILike(`%${q}%`);
    return this.accounts.find({ where, order: { createdAt: 'DESC' }, take: 500 });
  }
  createAccount(caller: SalesCaller, dto: CreateAccountDto) {
    return this.accounts.save(this.accounts.create({
      organizationId: caller.orgId, name: dto.name.trim(), domain: dto.domain?.toLowerCase() ?? null,
      industry: dto.industry ?? null, size: dto.size ?? null, website: dto.website ?? null, phone: dto.phone ?? null,
      tags: dto.tags ?? [], createdBy: caller.userId, isDeleted: false,
    }));
  }
  async updateAccount(orgId: string, id: string, dto: UpdateAccountDto) {
    const a = await this.accounts.findOne({ where: { id, organizationId: orgId, isDeleted: false } });
    if (!a) throw new NotFoundException('Account not found');
    Object.assign(a, {
      name: dto.name?.trim() ?? a.name, domain: dto.domain?.toLowerCase() ?? a.domain, industry: dto.industry ?? a.industry,
      size: dto.size ?? a.size, website: dto.website ?? a.website, phone: dto.phone ?? a.phone, tags: dto.tags ?? a.tags,
    });
    return this.accounts.save(a);
  }
  async deleteAccount(orgId: string, id: string) {
    await this.accounts.update({ id, organizationId: orgId }, { isDeleted: true });
    return { success: true as const };
  }

  async listContacts(orgId: string, q?: string) {
    const where: Record<string, unknown> = { organizationId: orgId, isDeleted: false };
    if (q) where.name = ILike(`%${q}%`);
    const rows = await this.contacts.find({ where, order: { createdAt: 'DESC' }, take: 500 });
    const accIds = [...new Set(rows.map((c) => c.accountId).filter(Boolean) as string[])];
    const accs = accIds.length ? await this.accounts.find({ where: { id: In(accIds) } }) : [];
    const nameById = new Map(accs.map((a) => [a.id, a.name]));
    return rows.map((c) => ({ ...c, accountName: c.accountId ? nameById.get(c.accountId) ?? null : null }));
  }
  createContact(caller: SalesCaller, dto: CreateContactDto) {
    return this.contacts.save(this.contacts.create({
      organizationId: caller.orgId, name: dto.name.trim(), email: dto.email?.toLowerCase() ?? null, phone: dto.phone ?? null,
      title: dto.title ?? null, accountId: dto.accountId ?? null, tags: dto.tags ?? [], createdBy: caller.userId, isDeleted: false,
    }));
  }
  async updateContact(orgId: string, id: string, dto: UpdateContactDto) {
    const c = await this.contacts.findOne({ where: { id, organizationId: orgId, isDeleted: false } });
    if (!c) throw new NotFoundException('Contact not found');
    Object.assign(c, {
      name: dto.name?.trim() ?? c.name, email: dto.email?.toLowerCase() ?? c.email, phone: dto.phone ?? c.phone,
      title: dto.title ?? c.title, accountId: dto.accountId ?? c.accountId, tags: dto.tags ?? c.tags,
    });
    return this.contacts.save(c);
  }
  async deleteContact(orgId: string, id: string) {
    await this.contacts.update({ id, organizationId: orgId }, { isDeleted: true });
    return { success: true as const };
  }

  // ── dashboard overview ───────────────────────────────────────────────────────

  async overview(orgId: string) {
    const [stages, all] = await Promise.all([
      this.ensureStages(orgId),
      this.leads.find({ where: { organizationId: orgId, isDeleted: false } }),
    ]);
    const probById = new Map(stages.map((s) => [s.id, s.probability]));
    const open = all.filter((l) => l.status === 'open');
    const won = all.filter((l) => l.status === 'won');
    const val = (l: LeadEntity) => Number(l.value ?? 0);
    const openValue = open.reduce((s, l) => s + val(l), 0);
    const weightedForecast = open.reduce((s, l) => s + val(l) * ((l.stageId ? probById.get(l.stageId) ?? 0 : 0) / 100), 0);
    const wonValue = won.reduce((s, l) => s + val(l), 0);
    const closed = all.filter((l) => l.status === 'won' || l.status === 'lost').length;
    const byStage = stages.map((s) => {
      const leads = open.filter((l) => l.stageId === s.id);
      return { stageId: s.id, name: s.name, color: s.color, count: leads.length, value: leads.reduce((a, l) => a + val(l), 0) };
    });

    return {
      totalLeads: all.length, openLeads: open.length, wonLeads: won.length,
      openValue, weightedForecast, wonValue,
      winRate: closed ? won.length / closed : 0,
      byStage,
    };
  }

  // ── analytics ──────────────────────────────────────────────────────────────────

  async analytics(orgId: string) {
    const [stages, leads] = await Promise.all([
      this.ensureStages(orgId),
      this.leads.find({ where: { organizationId: orgId, isDeleted: false } }),
    ]);
    const probById = new Map(stages.map((s) => [s.id, s.probability]));
    const val = (l: LeadEntity) => Number(l.value ?? 0);

    // Rep leaderboard (per assignee).
    const ownerIds = new Set<string>();
    leads.forEach((l) => l.assignedTo && ownerIds.add(l.assignedTo));
    const users = ownerIds.size ? await this.users.find({ where: { id: In([...ownerIds]) } }) : [];
    const nameById = new Map(users.map((u) => [u.id, nameOf(u)]));
    const leaderboard = [...ownerIds].map((uid) => {
      const mine = leads.filter((l) => l.assignedTo === uid);
      const openL = mine.filter((l) => l.status === 'open');
      const wonL = mine.filter((l) => l.status === 'won');
      const closedL = mine.filter((l) => l.status === 'won' || l.status === 'lost').length;
      return {
        userId: uid, name: nameById.get(uid) ?? 'Member',
        leads: mine.length,
        openValue: openL.reduce((s, l) => s + val(l), 0),
        wonValue: wonL.reduce((s, l) => s + val(l), 0),
        winRate: closedL ? wonL.length / closedL : 0,
      };
    }).sort((a, b) => b.wonValue - a.wonValue);

    // Leads by source + won conversion.
    const bySource = [...new Set(leads.map((l) => l.source))].map((source) => {
      const rows = leads.filter((l) => l.source === source);
      return { source, count: rows.length, converted: rows.filter((l) => l.status === 'won').length };
    }).sort((a, b) => b.count - a.count);

    // Monthly won revenue (last 6 months, by wonAt).
    const now = new Date();
    const months: { month: string; label: string; wonValue: number; wonCount: number }[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      months.push({ month: key, label: d.toLocaleString(undefined, { month: 'short' }), wonValue: 0, wonCount: 0 });
    }
    const monthIdx = new Map(months.map((m, i) => [m.month, i]));
    for (const l of leads) {
      if (l.status !== 'won' || !l.wonAt) continue;
      const wa = new Date(l.wonAt);
      const key = `${wa.getFullYear()}-${String(wa.getMonth() + 1).padStart(2, '0')}`;
      const idx = monthIdx.get(key);
      if (idx != null) { months[idx].wonValue += val(l); months[idx].wonCount += 1; }
    }

    // Avg sales cycle (days from lead created → won).
    const wonWithCycle = leads.filter((l) => l.status === 'won' && l.wonAt);
    const avgCycleDays = wonWithCycle.length
      ? Math.round(wonWithCycle.reduce((s, l) => s + (new Date(l.wonAt!).getTime() - new Date(l.createdAt).getTime()) / 86_400_000, 0) / wonWithCycle.length)
      : 0;

    const open = leads.filter((l) => l.status === 'open');
    const won = leads.filter((l) => l.status === 'won');
    const closed = leads.filter((l) => l.status === 'won' || l.status === 'lost').length;
    return {
      totals: {
        openValue: open.reduce((s, l) => s + val(l), 0),
        weightedForecast: open.reduce((s, l) => s + val(l) * ((l.stageId ? probById.get(l.stageId) ?? 0 : 0) / 100), 0),
        wonValue: won.reduce((s, l) => s + val(l), 0),
        winRate: closed ? won.length / closed : 0,
        avgCycleDays,
        totalLeads: leads.length,
      },
      funnel: stages.map((s) => {
        const ls = open.filter((l) => l.stageId === s.id);
        return { stageId: s.id, name: s.name, color: s.color, count: ls.length, value: ls.reduce((a, l) => a + val(l), 0) };
      }),
      leaderboard, bySource, monthly: months,
    };
  }

  // ── import / export ────────────────────────────────────────────────────────────

  private csvCell(v: unknown): string {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  async exportLeadsCsv(orgId: string): Promise<string> {
    const rows = await this.leads.find({ where: { organizationId: orgId, isDeleted: false }, order: { createdAt: 'DESC' } });
    const stages = await this.ensureStages(orgId);
    const stageName = new Map(stages.map((s) => [s.id, s.name]));
    const clientName = await this.clientNames(orgId, rows.map((l) => l.sourceClientId));
    const sourceLabel = (l: LeadEntity) =>
      l.source === 'other' && l.sourceDetail ? l.sourceDetail
        : l.source === 'client' && l.sourceClientId && clientName.has(l.sourceClientId) ? `Client: ${clientName.get(l.sourceClientId)}`
          : l.sourceMeta?.[LEAD_SOURCE_FIELDS[l.source]?.[0] ?? ''] ? `${l.source}: ${l.sourceMeta[LEAD_SOURCE_FIELDS[l.source][0]]}`
            : l.source;
    const header = ['Name', 'Company', 'Email', 'Phone', 'Title', 'Source', 'Stage', 'Status', 'Value', 'Currency', 'Tags', 'Created'];
    const lines = [header.join(',')];
    for (const l of rows) {
      lines.push([
        l.name, l.company, l.email, l.phone, l.title, sourceLabel(l), l.stageId ? stageName.get(l.stageId) ?? '' : '',
        l.status, l.value ?? '', l.currency, (l.tags ?? []).join('; '), new Date(l.createdAt).toISOString().slice(0, 10),
      ].map((c) => this.csvCell(c)).join(','));
    }
    return lines.join('\n');
  }

  /** Bulk-create leads from imported rows (e.g. a CSV export from Excel). */
  async importLeads(caller: SalesCaller, rows: Array<Record<string, any>>): Promise<{ created: number; skipped: number }> {
    const stages = await this.ensureStages(caller.orgId);
    const defaultStage = stages.find((s) => s.isDefault)?.id || stages[0]?.id || null;
    const valid = (rows || []).filter((r) => (r.name ?? '').toString().trim());
    let created = 0;
    for (const chunk of this.chunk(valid, 100)) {
      const entities = chunk.map((r) => this.leads.create({
        organizationId: caller.orgId, name: String(r.name).trim(),
        company: r.company ? String(r.company).trim() : null,
        email: r.email ? String(r.email).toLowerCase().trim() : null,
        phone: r.phone ? String(r.phone).trim() : null,
        title: r.title ? String(r.title).trim() : null,
        source: 'import', stageId: defaultStage, status: 'open',
        value: r.value != null && r.value !== '' ? String(Number(r.value) || 0) : null,
        currency: (r.currency ? String(r.currency) : 'INR').toUpperCase(),
        tags: Array.isArray(r.tags) ? r.tags : (r.tags ? String(r.tags).split(/[;,]/).map((x: string) => x.trim()).filter(Boolean) : []),
        score: 0, createdBy: caller.userId, isDeleted: false,
      }));
      await this.leads.save(entities);
      created += entities.length;
    }
    return { created, skipped: (rows?.length ?? 0) - created };
  }

  private chunk<T>(arr: T[], n: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  private async withNames(rows: LeadEntity[]) {
    const ids = [...new Set(rows.map((l) => l.assignedTo).filter(Boolean) as string[])];
    const [users, clientName] = await Promise.all([
      ids.length ? this.users.find({ where: { id: In(ids) } }) : Promise.resolve([] as UserEntity[]),
      this.clientNames(rows[0]?.organizationId, rows.map((l) => l.sourceClientId)),
    ]);
    const byId = new Map(users.map((u) => [u.id, nameOf(u)]));
    return rows.map((l) => ({
      ...l, value: l.value != null ? Number(l.value) : null,
      assignedToName: l.assignedTo ? byId.get(l.assignedTo) ?? null : null,
      sourceClientName: l.sourceClientId ? clientName.get(l.sourceClientId) ?? null : null,
    }));
  }

  /** Display names for the given client ids within the org (archived/deleted clients keep their name). */
  private async clientNames(orgId: string | undefined, ids: Array<string | null>): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter(Boolean) as string[])];
    if (!orgId || !unique.length) return new Map();
    const rows = await this.clientRecords.find({ where: { id: In(unique), organizationId: orgId }, select: { id: true, companyName: true, displayName: true } });
    return new Map(rows.map((c) => [c.id, c.displayName || c.companyName]));
  }

  /**
   * A lead sourced from a client must point at a live client in the same org;
   * any other source carries no client. Returns the id to store.
   */
  /** Keep only the detail fields that belong to `source`, trimmed and capped; null when nothing is left. */
  private cleanSourceMeta(source: string, meta: Record<string, unknown> | null | undefined): Record<string, string> | null {
    const allowed = LEAD_SOURCE_FIELDS[source as LeadSource] ?? [];
    if (!meta || typeof meta !== 'object' || !allowed.length) return null;
    const out: Record<string, string> = {};
    for (const key of allowed) {
      const v = meta[key];
      if (typeof v === 'string' && v.trim()) out[key] = v.trim().slice(0, 300);
    }
    return Object.keys(out).length ? out : null;
  }

  private async resolveSourceClient(orgId: string, source: string, sourceClientId: string | null | undefined): Promise<string | null> {
    return (await this.findSourceClient(orgId, source, sourceClientId))?.id ?? null;
  }

  private async findSourceClient(orgId: string, source: string, sourceClientId: string | null | undefined): Promise<ClientEntity | null> {
    if (source !== 'client') return null;
    if (!sourceClientId) throw new BadRequestException('Choose the client this lead came from');
    const client = await this.clientRecords.findOne({ where: { id: sourceClientId, organizationId: orgId, isDeleted: false } });
    if (!client) throw new BadRequestException('Client not found');
    return client;
  }

  private notifyAssignment(orgId: string, userId: string, lead: LeadEntity, actorId: string) {
    void this.notifier?.notify({
      organizationId: orgId, userId, actorId, type: 'lead_assigned',
      title: `You've been assigned a lead: ${lead.name}`,
      body: lead.company ?? null,
      data: { actionUrl: `/sales/leads/${lead.id}`, leadId: lead.id },
      email: EMAIL_OVERRIDES.leadAssigned,
    }).catch(() => undefined);
  }
}
