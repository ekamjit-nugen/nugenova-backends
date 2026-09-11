import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, ILike, In, Repository } from 'typeorm';

import { PipelineStageEntity } from './entities/pipeline-stage.entity';
import { LeadEntity } from './entities/lead.entity';
import { SalesAccountEntity } from './entities/sales-account.entity';
import { SalesContactEntity } from './entities/sales-contact.entity';
import { SalesActivityEntity } from './entities/sales-activity.entity';
import { SalesFollowupEntity } from './entities/sales-followup.entity';
import { DealEntity } from './entities/deal.entity';
import { RequirementEntity } from './entities/requirement.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { NotifierService } from '../notification/notifier.service';
import { DEFAULT_STAGES, SalesEntityType } from './sales.constants';
import {
  ConvertLeadDto, CreateAccountDto, CreateActivityDto, CreateContactDto, CreateDealDto, CreateFollowupDto, CreateLeadDto,
  CreateRequirementDto, CreateStageDto, MoveStageDto, UpdateAccountDto, UpdateContactDto, UpdateDealDto, UpdateFollowupDto,
  UpdateLeadDto, UpdateRequirementDto,
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
    @InjectRepository(DealEntity) private readonly deals: Repository<DealEntity>,
    @InjectRepository(RequirementEntity) private readonly requirements: Repository<RequirementEntity>,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
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
    const [stage, activities, followups] = await Promise.all([
      lead.stageId ? this.stages.findOne({ where: { id: lead.stageId } }) : null,
      this.activities.find({ where: { organizationId: orgId, entityType: 'lead', entityId: id, isDeleted: false }, order: { occurredAt: 'DESC' } }),
      this.followups.find({ where: { organizationId: orgId, entityType: 'lead', entityId: id, isDeleted: false }, order: { dueAt: 'ASC' } }),
    ]);
    const [withName] = await this.withNames([lead]);
    return { lead: withName, stage, activities, followups };
  }

  async createLead(caller: SalesCaller, dto: CreateLeadDto): Promise<LeadEntity> {
    const stages = await this.ensureStages(caller.orgId);
    const stageId = dto.stageId || stages.find((s) => s.isDefault)?.id || stages[0]?.id || null;
    const lead = await this.leads.save(this.leads.create({
      organizationId: caller.orgId,
      name: dto.name.trim(), company: dto.company ?? null, email: dto.email?.toLowerCase() ?? null, phone: dto.phone ?? null,
      title: dto.title ?? null, source: (dto.source ?? 'other') as any, stageId, status: 'open',
      value: dto.value != null ? String(dto.value) : null, currency: dto.currency?.toUpperCase() ?? 'INR',
      assignedTo: dto.assignedTo ?? null, score: 0, tags: dto.tags ?? [], notes: dto.notes ?? null,
      createdBy: caller.userId, isDeleted: false,
    }));
    await this.logActivity(caller, 'lead', lead.id, 'system', 'Lead created');
    if (dto.assignedTo && dto.assignedTo !== caller.userId) this.notifyAssignment(caller.orgId, dto.assignedTo, lead, caller.userId);
    return lead;
  }

  async updateLead(caller: SalesCaller, id: string, dto: UpdateLeadDto): Promise<LeadEntity> {
    const l = await this.requireLead(caller.orgId, id);
    const prevAssignee = l.assignedTo;
    if (dto.name !== undefined) l.name = dto.name.trim();
    if (dto.company !== undefined) l.company = dto.company;
    if (dto.email !== undefined) l.email = dto.email?.toLowerCase() ?? null;
    if (dto.phone !== undefined) l.phone = dto.phone;
    if (dto.title !== undefined) l.title = dto.title;
    if (dto.source !== undefined) l.source = dto.source as any;
    if (dto.status !== undefined) l.status = dto.status as any;
    if (dto.value !== undefined) l.value = dto.value != null ? String(dto.value) : null;
    if (dto.currency !== undefined) l.currency = dto.currency.toUpperCase();
    if (dto.assignedTo !== undefined) l.assignedTo = dto.assignedTo || null;
    if (dto.score !== undefined) l.score = dto.score;
    if (dto.tags !== undefined) l.tags = dto.tags;
    if (dto.notes !== undefined) l.notes = dto.notes;
    if (dto.stageId !== undefined && dto.stageId !== l.stageId) return this.moveStage(caller, id, { stageId: dto.stageId });
    const saved = await this.leads.save(l);
    if (dto.assignedTo && dto.assignedTo !== prevAssignee && dto.assignedTo !== caller.userId) this.notifyAssignment(caller.orgId, dto.assignedTo, saved, caller.userId);
    return saved;
  }

  /** Move a lead to another stage; won/lost stages set the lead status + a timeline note. */
  async moveStage(caller: SalesCaller, id: string, dto: MoveStageDto): Promise<LeadEntity> {
    const l = await this.requireLead(caller.orgId, id);
    const stage = await this.stages.findOne({ where: { id: dto.stageId, organizationId: caller.orgId, isDeleted: false } });
    if (!stage) throw new BadRequestException('Stage not found');
    l.stageId = stage.id;
    l.status = stage.isWon ? 'won' : stage.isLost ? 'lost' : 'open';
    const saved = await this.leads.save(l);
    await this.logActivity(caller, 'lead', id, 'stage_change', `Moved to ${stage.name}`);
    return saved;
  }

  async deleteLead(orgId: string, id: string): Promise<{ success: true }> {
    const l = await this.requireLead(orgId, id);
    l.isDeleted = true;
    await this.leads.save(l);
    return { success: true };
  }

  // ── activities + follow-ups ──────────────────────────────────────────────────

  private async logActivity(caller: SalesCaller, entityType: SalesEntityType, entityId: string, type: string, body: string | null) {
    const user = caller.userId ? await this.users.findOne({ where: { id: caller.userId } }) : null;
    await this.activities.save(this.activities.create({
      organizationId: caller.orgId, entityType, entityId, type: type as any, body,
      occurredAt: new Date(), createdBy: caller.userId ?? null, createdByName: nameOf(user), isDeleted: false,
    }));
    await this.touchEntity(caller.orgId, entityType, entityId);
  }

  async addActivity(caller: SalesCaller, entityType: SalesEntityType, entityId: string, dto: CreateActivityDto) {
    const user = await this.users.findOne({ where: { id: caller.userId } });
    const a = await this.activities.save(this.activities.create({
      organizationId: caller.orgId, entityType, entityId, type: dto.type as any, body: dto.body ?? null,
      occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : new Date(), createdBy: caller.userId, createdByName: nameOf(user), isDeleted: false,
    }));
    await this.touchEntity(caller.orgId, entityType, entityId);
    return a;
  }

  private async touchEntity(orgId: string, entityType: SalesEntityType, entityId: string) {
    const now = new Date();
    if (entityType === 'lead') await this.leads.update({ id: entityId, organizationId: orgId }, { lastActivityAt: now });
    else if (entityType === 'deal') await this.deals.update({ id: entityId, organizationId: orgId }, { lastActivityAt: now });
    else if (entityType === 'account') await this.accounts.update({ id: entityId, organizationId: orgId }, { lastActivityAt: now });
    else if (entityType === 'contact') await this.contacts.update({ id: entityId, organizationId: orgId }, { lastActivityAt: now });
  }

  // ── deals ────────────────────────────────────────────────────────────────────

  private async requireDeal(orgId: string, id: string): Promise<DealEntity> {
    const d = await this.deals.findOne({ where: { id, organizationId: orgId, isDeleted: false } });
    if (!d) throw new NotFoundException('Deal not found');
    return d;
  }

  private async dealsWithNames(rows: DealEntity[]) {
    const ids = [...new Set(rows.map((d) => d.assignedTo).filter(Boolean) as string[])];
    const users = ids.length ? await this.users.find({ where: { id: In(ids) } }) : [];
    const byId = new Map(users.map((u) => [u.id, nameOf(u)]));
    return rows.map((d) => ({ ...d, amount: d.amount != null ? Number(d.amount) : null, assignedToName: d.assignedTo ? byId.get(d.assignedTo) ?? null : null }));
  }

  async listDeals(orgId: string, f: { status?: string; stageId?: string; assignedTo?: string; q?: string }) {
    const qb = this.deals.createQueryBuilder('d').where('d.organization_id = :orgId AND d.is_deleted = false', { orgId });
    if (f.status) qb.andWhere('d.status = :status', { status: f.status });
    if (f.stageId) qb.andWhere('d.stage_id = :stageId', { stageId: f.stageId });
    if (f.assignedTo) qb.andWhere('d.assigned_to = :assignedTo', { assignedTo: f.assignedTo });
    if (f.q) qb.andWhere('d.title ILIKE :q', { q: `%${f.q}%` });
    return this.dealsWithNames(await qb.orderBy('d.updated_at', 'DESC').take(500).getMany());
  }

  async dealBoard(orgId: string, includeClosed = false) {
    const stages = await this.ensureStages(orgId);
    const where: Record<string, unknown> = { organizationId: orgId, isDeleted: false };
    if (!includeClosed) where.status = 'open';
    const rows = await this.deals.find({ where, order: { updatedAt: 'DESC' } });
    return { stages, deals: await this.dealsWithNames(rows) };
  }

  async getDeal(orgId: string, id: string) {
    const deal = await this.requireDeal(orgId, id);
    const [stage, activities, followups, requirements] = await Promise.all([
      deal.stageId ? this.stages.findOne({ where: { id: deal.stageId } }) : null,
      this.activities.find({ where: { organizationId: orgId, entityType: 'deal', entityId: id, isDeleted: false }, order: { occurredAt: 'DESC' } }),
      this.followups.find({ where: { organizationId: orgId, entityType: 'deal', entityId: id, isDeleted: false }, order: { dueAt: 'ASC' } }),
      this.requirements.find({ where: { organizationId: orgId, entityType: 'deal', entityId: id, isDeleted: false }, order: { createdAt: 'ASC' } }),
    ]);
    const [withName] = await this.dealsWithNames([deal]);
    return { deal: withName, stage, activities, followups, requirements: requirements.map((r) => this.requirementView(r)), effort: this.rollupEffort(requirements) };
  }

  async createDeal(caller: SalesCaller, dto: CreateDealDto): Promise<DealEntity> {
    const stages = await this.ensureStages(caller.orgId);
    const stageId = dto.stageId || stages.find((s) => s.isDefault)?.id || stages[0]?.id || null;
    const deal = await this.deals.save(this.deals.create({
      organizationId: caller.orgId, title: dto.title.trim(), accountId: dto.accountId ?? null, contactId: dto.contactId ?? null,
      stageId, status: 'open', amount: dto.amount != null ? String(dto.amount) : null, currency: dto.currency?.toUpperCase() ?? 'INR',
      assignedTo: dto.assignedTo ?? null, tags: dto.tags ?? [], notes: dto.notes ?? null,
      expectedCloseDate: dto.expectedCloseDate ? new Date(dto.expectedCloseDate) : null, createdBy: caller.userId, isDeleted: false,
    }));
    await this.logActivity(caller, 'deal', deal.id, 'system', 'Deal created');
    return deal;
  }

  async updateDeal(caller: SalesCaller, id: string, dto: UpdateDealDto): Promise<DealEntity> {
    const d = await this.requireDeal(caller.orgId, id);
    if (dto.title !== undefined) d.title = dto.title.trim();
    if (dto.accountId !== undefined) d.accountId = dto.accountId || null;
    if (dto.contactId !== undefined) d.contactId = dto.contactId || null;
    if (dto.amount !== undefined) d.amount = dto.amount != null ? String(dto.amount) : null;
    if (dto.currency !== undefined) d.currency = dto.currency.toUpperCase();
    if (dto.assignedTo !== undefined) d.assignedTo = dto.assignedTo || null;
    if (dto.expectedCloseDate !== undefined) d.expectedCloseDate = dto.expectedCloseDate ? new Date(dto.expectedCloseDate) : null;
    if (dto.lostReason !== undefined) d.lostReason = dto.lostReason;
    if (dto.tags !== undefined) d.tags = dto.tags;
    if (dto.notes !== undefined) d.notes = dto.notes;
    if (dto.status !== undefined) { d.status = dto.status as any; if (dto.status === 'won') d.wonAt = new Date(); if (dto.status === 'lost') d.lostAt = new Date(); }
    if (dto.stageId !== undefined && dto.stageId !== d.stageId) return this.moveDealStage(caller, id, { stageId: dto.stageId });
    return this.deals.save(d);
  }

  async moveDealStage(caller: SalesCaller, id: string, dto: MoveStageDto): Promise<DealEntity> {
    const d = await this.requireDeal(caller.orgId, id);
    const stage = await this.stages.findOne({ where: { id: dto.stageId, organizationId: caller.orgId, isDeleted: false } });
    if (!stage) throw new BadRequestException('Stage not found');
    d.stageId = stage.id;
    if (stage.isWon) { d.status = 'won'; d.wonAt = new Date(); }
    else if (stage.isLost) { d.status = 'lost'; d.lostAt = new Date(); }
    else d.status = 'open';
    const saved = await this.deals.save(d);
    await this.logActivity(caller, 'deal', id, 'stage_change', `Moved to ${stage.name}`);
    return saved;
  }

  async deleteDeal(orgId: string, id: string) {
    await this.deals.update({ id, organizationId: orgId }, { isDeleted: true });
    return { success: true as const };
  }

  /** Set a deal's amount from its requirements' rolled-up estimate. */
  async rollupDealAmount(caller: SalesCaller, id: string): Promise<DealEntity> {
    const d = await this.requireDeal(caller.orgId, id);
    const reqs = await this.requirements.find({ where: { organizationId: caller.orgId, entityType: 'deal', entityId: id, isDeleted: false } });
    d.amount = String(this.rollupEffort(reqs).totalAmount);
    return this.deals.save(d);
  }

  // ── lead → deal conversion ─────────────────────────────────────────────────────

  async convertLead(caller: SalesCaller, leadId: string, dto: ConvertLeadDto) {
    const lead = await this.requireLead(caller.orgId, leadId);
    if (lead.convertedToDealId) throw new BadRequestException('This lead has already been converted');
    let accountId: string | null = null;
    let contactId: string | null = null;
    if (dto.createAccount && lead.company) {
      const acc = await this.accounts.save(this.accounts.create({ organizationId: caller.orgId, name: lead.company, tags: [], createdBy: caller.userId, isDeleted: false }));
      accountId = acc.id;
    }
    if (dto.createContact) {
      const con = await this.contacts.save(this.contacts.create({ organizationId: caller.orgId, name: lead.name, email: lead.email, phone: lead.phone, title: lead.title, accountId, tags: [], createdBy: caller.userId, isDeleted: false }));
      contactId = con.id;
    }
    const deal = await this.deals.save(this.deals.create({
      organizationId: caller.orgId, title: dto.title?.trim() || `${lead.company || lead.name} deal`,
      accountId, contactId, sourceLeadId: lead.id, stageId: dto.stageId || lead.stageId,
      status: 'open', amount: dto.amount != null ? String(dto.amount) : lead.value, currency: lead.currency,
      assignedTo: lead.assignedTo, tags: lead.tags ?? [], createdBy: caller.userId, isDeleted: false,
    }));
    // Move the lead's open requirements onto the deal.
    await this.requirements.update({ organizationId: caller.orgId, entityType: 'lead', entityId: lead.id, isDeleted: false }, { entityType: 'deal', entityId: deal.id });
    lead.convertedToDealId = deal.id;
    lead.convertedAt = new Date();
    await this.leads.save(lead);
    await this.logActivity(caller, 'deal', deal.id, 'system', `Converted from lead ${lead.name}`);
    return this.getDeal(caller.orgId, deal.id);
  }

  // ── requirements (effort estimation) ───────────────────────────────────────────

  private requirementView(r: RequirementEntity) {
    const quantity = Number(r.quantity ?? 0);
    const rate = Number(r.rate ?? 0);
    return {
      id: r.id, entityType: r.entityType, entityId: r.entityId, title: r.title, details: r.details, category: r.category,
      role: r.role, skills: r.skills ?? [], priority: r.priority, status: r.status, unit: r.unit,
      quantity, rate, amount: quantity * rate, neededBy: r.neededBy, assignedTo: r.assignedTo, createdAt: r.createdAt,
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
      priority: dto.priority ?? 'must_have', status: dto.status ?? 'open', unit: dto.unit ?? 'hours',
      quantity: String(dto.quantity ?? 0), rate: String(dto.rate ?? 0),
      neededBy: dto.neededBy ? new Date(dto.neededBy) : null, assignedTo: dto.assignedTo ?? null, createdBy: caller.userId, isDeleted: false,
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
    if (dto.priority !== undefined) r.priority = dto.priority;
    if (dto.status !== undefined) r.status = dto.status;
    if (dto.unit !== undefined) r.unit = dto.unit;
    if (dto.quantity !== undefined) r.quantity = String(dto.quantity);
    if (dto.rate !== undefined) r.rate = String(dto.rate);
    if (dto.neededBy !== undefined) r.neededBy = dto.neededBy ? new Date(dto.neededBy) : null;
    if (dto.assignedTo !== undefined) r.assignedTo = dto.assignedTo || null;
    return this.requirementView(await this.requirements.save(r));
  }

  async deleteRequirement(orgId: string, id: string) {
    await this.requirements.update({ id, organizationId: orgId }, { isDeleted: true });
    return { success: true as const };
  }

  async addFollowup(caller: SalesCaller, entityType: SalesEntityType, entityId: string, dto: CreateFollowupDto) {
    const f = await this.followups.save(this.followups.create({
      organizationId: caller.orgId, entityType, entityId, dueAt: new Date(dto.dueAt), note: dto.note ?? null,
      status: 'pending', assignedTo: dto.assignedTo ?? caller.userId, createdBy: caller.userId, isDeleted: false,
    }));
    if (entityType === 'lead') await this.leads.update({ id: entityId, organizationId: caller.orgId }, { nextFollowUpAt: f.dueAt });
    return f;
  }

  async updateFollowup(orgId: string, id: string, dto: UpdateFollowupDto) {
    const f = await this.followups.findOne({ where: { id, organizationId: orgId, isDeleted: false } });
    if (!f) throw new NotFoundException('Follow-up not found');
    if (dto.status !== undefined) { f.status = dto.status as any; if (dto.status === 'done') f.completedAt = new Date(); }
    if (dto.dueAt !== undefined) f.dueAt = new Date(dto.dueAt);
    if (dto.note !== undefined) f.note = dto.note;
    return this.followups.save(f);
  }

  /** Open follow-ups for the org (optionally only the caller's), soonest first. */
  async listFollowups(orgId: string, assignedTo?: string) {
    const where: Record<string, unknown> = { organizationId: orgId, isDeleted: false, status: In(['pending', 'snoozed']) };
    if (assignedTo) where.assignedTo = assignedTo;
    return this.followups.find({ where, order: { dueAt: 'ASC' }, take: 200 });
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
    const [stages, all, allDeals] = await Promise.all([
      this.ensureStages(orgId),
      this.leads.find({ where: { organizationId: orgId, isDeleted: false } }),
      this.deals.find({ where: { organizationId: orgId, isDeleted: false } }),
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

    // Deals (the qualified pipeline / real forecast).
    const dval = (d: DealEntity) => Number(d.amount ?? 0);
    const openDeals = allDeals.filter((d) => d.status === 'open');
    const wonDeals = allDeals.filter((d) => d.status === 'won');
    const closedDeals = allDeals.filter((d) => d.status === 'won' || d.status === 'lost').length;
    const deals = {
      total: allDeals.length, open: openDeals.length, won: wonDeals.length,
      openValue: openDeals.reduce((s, d) => s + dval(d), 0),
      weightedForecast: openDeals.reduce((s, d) => s + dval(d) * ((d.stageId ? probById.get(d.stageId) ?? 0 : 0) / 100), 0),
      wonValue: wonDeals.reduce((s, d) => s + dval(d), 0),
      winRate: closedDeals ? wonDeals.length / closedDeals : 0,
      byStage: stages.map((s) => {
        const ds = openDeals.filter((d) => d.stageId === s.id);
        return { stageId: s.id, name: s.name, color: s.color, count: ds.length, value: ds.reduce((a, d) => a + dval(d), 0) };
      }),
    };

    return {
      totalLeads: all.length, openLeads: open.length, wonLeads: won.length,
      openValue, weightedForecast, wonValue,
      winRate: closed ? won.length / closed : 0,
      byStage,
      deals,
    };
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  private async withNames(rows: LeadEntity[]) {
    const ids = [...new Set(rows.map((l) => l.assignedTo).filter(Boolean) as string[])];
    const users = ids.length ? await this.users.find({ where: { id: In(ids) } }) : [];
    const byId = new Map(users.map((u) => [u.id, nameOf(u)]));
    return rows.map((l) => ({ ...l, value: l.value != null ? Number(l.value) : null, assignedToName: l.assignedTo ? byId.get(l.assignedTo) ?? null : null }));
  }

  private notifyAssignment(orgId: string, userId: string, lead: LeadEntity, actorId: string) {
    void this.notifier?.notify({
      organizationId: orgId, userId, actorId, type: 'lead_assigned',
      title: `You've been assigned a lead: ${lead.name}`,
      body: lead.company ?? null,
      data: { actionUrl: `/sales/leads/${lead.id}`, leadId: lead.id },
      email: { eyebrow: 'Sales', cta: 'View lead' },
    }).catch(() => undefined);
  }
}
