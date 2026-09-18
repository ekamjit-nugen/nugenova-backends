import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { VendorEntity } from './entities/vendor.entity';
import { VendorAgreementEntity, VendorAgreementField, VendorAgreementSignature } from './entities/vendor-agreement.entity';
import { VendorAgreementTemplateEntity } from './entities/vendor-agreement-template.entity';
import { VendorsCaller } from './vendors.service';
import {
  CreateVendorAgreementDto, CreateVendorAgreementTemplateDto, DeclineVendorAgreementDto,
  SignVendorAgreementDto, UpdateVendorAgreementDto, UpdateVendorAgreementTemplateDto,
  WaiveVendorAgreementDto,
} from './dto';

/** One line of the clearance report: a required agreement and where it stands. */
export interface ClearanceItem {
  templateId: string | null;
  agreementId: string | null;
  title: string;
  /** Set when the item is waived — why, and who decided it. */
  waivedReason?: string | null;
  waivedBy?: string | null;
  status: 'missing' | 'draft' | 'sent' | 'signed' | 'declined' | 'void' | 'expired' | 'waived';
  signedAt: Date | null;
  expiresAt: Date | null;
}

export interface Clearance {
  cleared: boolean;
  items: ClearanceItem[];
  outstanding: number;
}

/**
 * Vendor agreements — the org's reusable templates (MSA, NDA, code of conduct)
 * and the copy each vendor signs.
 *
 * Creating an agreement COPIES the template's content, so editing a template
 * never changes what a vendor already agreed to. A template is required or not,
 * and applies to every vendor or only to certain service categories; that is
 * what `clearance()` reads to decide whether a vendor may supply people, and
 * what keeps `vendors.onboardingStatus` honest.
 *
 * Until the vendor portal ships, a vendor can't sign in the app, so an admin
 * records the signature they received — `method: 'offline'` names the staff
 * member who recorded it rather than pretending the vendor clicked something.
 */
@Injectable()
export class VendorAgreementsService {
  constructor(
    @InjectRepository(VendorEntity) private readonly vendors: Repository<VendorEntity>,
    @InjectRepository(VendorAgreementEntity) private readonly agreements: Repository<VendorAgreementEntity>,
    @InjectRepository(VendorAgreementTemplateEntity) private readonly templates: Repository<VendorAgreementTemplateEntity>,
  ) {}

  // ── templates ──────────────────────────────────────────────────────────────

  listTemplates(orgId: string, includeArchived = false) {
    const where: Record<string, unknown> = { organizationId: orgId, isDeleted: false };
    if (!includeArchived) where.isArchived = false;
    return this.templates.find({ where, order: { createdAt: 'DESC' } });
  }

  createTemplate(caller: VendorsCaller, dto: CreateVendorAgreementTemplateDto) {
    this.requireContent(dto.bodyHtml, dto.sourceFileId);
    return this.templates.save(this.templates.create({
      organizationId: caller.orgId,
      name: dto.name.trim(),
      title: dto.title?.trim() || null,
      category: dto.category ?? 'other',
      bodyHtml: dto.bodyHtml ?? null,
      sourceFileId: dto.sourceFileId ?? null,
      fields: (dto.fields ?? null) as VendorAgreementField[] | null,
      required: dto.required ?? false,
      appliesToCategories: dto.appliesToCategories ?? [],
      isArchived: false,
      createdBy: caller.userId,
      isDeleted: false,
    }));
  }

  async updateTemplate(orgId: string, templateId: string, dto: UpdateVendorAgreementTemplateDto) {
    const t = await this.requireTemplate(orgId, templateId);
    if (dto.name !== undefined) t.name = dto.name.trim();
    if (dto.title !== undefined) t.title = dto.title?.trim() || null;
    if (dto.category !== undefined) t.category = dto.category;
    if (dto.bodyHtml !== undefined) t.bodyHtml = dto.bodyHtml ?? null;
    if (dto.sourceFileId !== undefined) t.sourceFileId = dto.sourceFileId ?? null;
    if (dto.fields !== undefined) t.fields = (dto.fields ?? null) as VendorAgreementField[] | null;
    if (dto.required !== undefined) t.required = dto.required;
    if (dto.appliesToCategories !== undefined) t.appliesToCategories = dto.appliesToCategories ?? [];
    if (dto.isArchived !== undefined) t.isArchived = dto.isArchived;
    this.requireContent(t.bodyHtml, t.sourceFileId);
    return this.templates.save(t);
  }

  /**
   * Archive rather than delete once a template has been issued: agreements keep
   * their own copy of the text, but the link back is what tells an admin where
   * a vendor's MSA came from.
   */
  async deleteTemplate(orgId: string, templateId: string) {
    const t = await this.requireTemplate(orgId, templateId);
    const issued = await this.agreements.count({ where: { organizationId: orgId, templateId, isDeleted: false } });
    if (issued > 0) {
      t.isArchived = true;
      await this.templates.save(t);
      return { id: templateId, archived: true };
    }
    t.isDeleted = true;
    await this.templates.save(t);
    return { id: templateId, archived: false };
  }

  // ── agreements ─────────────────────────────────────────────────────────────

  async list(orgId: string, vendorId: string) {
    await this.requireVendor(orgId, vendorId);
    return this.agreements.find({ where: { organizationId: orgId, vendorId, isDeleted: false }, order: { createdAt: 'DESC' } });
  }

  async create(caller: VendorsCaller, vendorId: string, dto: CreateVendorAgreementDto) {
    await this.requireVendor(caller.orgId, vendorId);
    const template = dto.templateId ? await this.requireTemplate(caller.orgId, dto.templateId) : null;

    // Template content is COPIED, never referenced: a vendor's agreement must
    // not change under them because someone edited the template afterwards.
    const title = dto.title?.trim() || template?.title || template?.name;
    if (!title) throw new BadRequestException('An agreement needs a title');
    const bodyHtml = dto.bodyHtml ?? template?.bodyHtml ?? null;
    const sourceFileId = dto.sourceFileId ?? template?.sourceFileId ?? null;
    this.requireContent(bodyHtml, sourceFileId);

    const agreement = await this.agreements.save(this.agreements.create({
      organizationId: caller.orgId,
      vendorId,
      templateId: template?.id ?? null,
      title,
      description: dto.description ?? null,
      category: dto.category ?? template?.category ?? 'other',
      bodyHtml,
      sourceFileId,
      fields: (dto.fields ?? template?.fields ?? null) as VendorAgreementField[] | null,
      signedFileId: null,
      status: 'draft',
      requiredForOnboarding: dto.requiredForOnboarding ?? template?.required ?? false,
      signature: null,
      sentAt: null,
      signedAt: null,
      declineReason: null,
      waived: false, waivedReason: null, waivedAt: null, waivedBy: null,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      createdBy: caller.userId,
      isDeleted: false,
    }));
    await this.syncOnboarding(caller.orgId, vendorId);
    return agreement;
  }

  /**
   * Issue every required template this vendor doesn't have yet — the one-click
   * start of onboarding, instead of picking templates one at a time.
   */
  async issueRequired(caller: VendorsCaller, vendorId: string) {
    const vendor = await this.requireVendor(caller.orgId, vendorId);
    const existing = await this.agreements.find({ where: { organizationId: caller.orgId, vendorId, isDeleted: false } });
    const already = new Set(existing.filter((a) => a.status !== 'void').map((a) => a.templateId).filter(Boolean) as string[]);
    const applicable = (await this.listTemplates(caller.orgId)).filter((t) => t.required && this.appliesTo(t, vendor));

    const created: VendorAgreementEntity[] = [];
    for (const t of applicable) {
      if (already.has(t.id)) continue;
      created.push(await this.create(caller, vendorId, { templateId: t.id }));
    }
    return { created: created.length, agreements: created };
  }

  async update(orgId: string, vendorId: string, id: string, dto: UpdateVendorAgreementDto) {
    const a = await this.requireAgreement(orgId, vendorId, id);
    if (a.status === 'signed') throw new BadRequestException('A signed agreement cannot be edited');
    if (dto.title !== undefined) a.title = dto.title.trim();
    if (dto.description !== undefined) a.description = dto.description ?? null;
    if (dto.category !== undefined) a.category = dto.category;
    if (dto.bodyHtml !== undefined) a.bodyHtml = dto.bodyHtml ?? null;
    if (dto.sourceFileId !== undefined) a.sourceFileId = dto.sourceFileId ?? null;
    if (dto.fields !== undefined) a.fields = (dto.fields ?? null) as VendorAgreementField[] | null;
    if (dto.requiredForOnboarding !== undefined) a.requiredForOnboarding = dto.requiredForOnboarding;
    if (dto.expiresAt !== undefined) a.expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    this.requireContent(a.bodyHtml, a.sourceFileId);
    const saved = await this.agreements.save(a);
    await this.syncOnboarding(orgId, vendorId);
    return saved;
  }

  /** Mark it as out with the vendor (draft → sent). */
  async send(orgId: string, vendorId: string, id: string) {
    const a = await this.requireAgreement(orgId, vendorId, id);
    if (a.status === 'signed') throw new BadRequestException('This agreement is already signed');
    if (a.status === 'void') throw new BadRequestException('A voided agreement cannot be sent');
    a.status = 'sent';
    a.sentAt = a.sentAt ?? new Date();
    const saved = await this.agreements.save(a);
    await this.syncOnboarding(orgId, vendorId);
    return saved;
  }

  /**
   * Record the vendor's signature. `signedAt` may be backdated to when the
   * vendor actually signed on paper; everything else is the audit trail.
   */
  async sign(caller: VendorsCaller, vendorId: string, id: string, dto: SignVendorAgreementDto, ip?: string, ua?: string) {
    const a = await this.requireAgreement(caller.orgId, vendorId, id);
    if (a.status === 'signed') throw new BadRequestException('This agreement is already signed');
    if (a.status === 'void') throw new BadRequestException('A voided agreement cannot be signed');
    if (!dto.signerName?.trim()) throw new BadRequestException('A signer name is required to sign');

    const signedAt = dto.signedAt ? new Date(dto.signedAt) : new Date();
    if (Number.isNaN(signedAt.getTime())) throw new BadRequestException('That signing date is not a date');
    if (signedAt.getTime() > Date.now()) throw new BadRequestException('An agreement cannot be signed in the future');

    const signature: VendorAgreementSignature = {
      signerName: dto.signerName.trim(),
      signerEmail: dto.signerEmail?.toLowerCase() ?? null,
      signedByUserId: caller.userId,
      signedAt: signedAt.toISOString(),
      ipAddress: ip ?? null,
      userAgent: ua ?? null,
      method: dto.method || (dto.signatureFileId ? 'drawn' : 'offline'),
      signatureFileId: dto.signatureFileId ?? null,
      fieldValues: (dto.fieldValues || []).reduce<Record<string, string>>((acc, f) => {
        if (f.value != null) acc[f.key] = f.value;
        return acc;
      }, {}),
      recordedNote: dto.recordedNote ?? null,
    };
    a.signature = signature;
    a.signedFileId = dto.signedFileId ?? null;
    a.status = 'signed';
    a.signedAt = signedAt;
    a.declineReason = null;
    const saved = await this.agreements.save(a);
    await this.syncOnboarding(caller.orgId, vendorId);
    return saved;
  }

  async decline(orgId: string, vendorId: string, id: string, dto: DeclineVendorAgreementDto) {
    const a = await this.requireAgreement(orgId, vendorId, id);
    if (a.status === 'signed') throw new BadRequestException('A signed agreement cannot be declined');
    a.status = 'declined';
    a.declineReason = dto.reason ?? null;
    const saved = await this.agreements.save(a);
    await this.syncOnboarding(orgId, vendorId);
    return saved;
  }

  /**
   * Waive a required agreement: the vendor is cleared without this signature.
   * The reason is mandatory — a waiver is somebody's decision, and the record
   * should say whose and why rather than the item quietly vanishing.
   */
  async waive(caller: VendorsCaller, vendorId: string, id: string, dto: WaiveVendorAgreementDto) {
    const a = await this.requireAgreement(caller.orgId, vendorId, id);
    if (a.status === 'signed') throw new BadRequestException('This agreement is already signed — there is nothing to waive');
    if (!dto.reason?.trim()) throw new BadRequestException('Give a reason for waiving this agreement');
    a.waived = true;
    a.waivedReason = dto.reason.trim();
    a.waivedAt = new Date();
    a.waivedBy = caller.userId;
    const saved = await this.agreements.save(a);
    await this.syncOnboarding(caller.orgId, vendorId);
    return saved;
  }

  /** Put a waived agreement back on the checklist. */
  async unwaive(orgId: string, vendorId: string, id: string) {
    const a = await this.requireAgreement(orgId, vendorId, id);
    if (!a.waived) throw new BadRequestException('This agreement is not waived');
    a.waived = false;
    a.waivedReason = null;
    a.waivedAt = null;
    a.waivedBy = null;
    const saved = await this.agreements.save(a);
    await this.syncOnboarding(orgId, vendorId);
    return saved;
  }

  /** Withdraw an unsigned agreement (draft/sent → void). */
  async void(orgId: string, vendorId: string, id: string) {
    const a = await this.requireAgreement(orgId, vendorId, id);
    if (a.status === 'signed') throw new BadRequestException('A signed agreement cannot be voided');
    a.status = 'void';
    const saved = await this.agreements.save(a);
    await this.syncOnboarding(orgId, vendorId);
    return saved;
  }

  async remove(orgId: string, vendorId: string, id: string) {
    const a = await this.requireAgreement(orgId, vendorId, id);
    if (a.status === 'signed') throw new BadRequestException('A signed agreement is a record — void it instead of deleting');
    a.isDeleted = true;
    await this.agreements.save(a);
    await this.syncOnboarding(orgId, vendorId);
    return { id };
  }

  // ── clearance ──────────────────────────────────────────────────────────────

  /**
   * Is this vendor cleared to supply people? Every required template that
   * applies to them must have a signed, unexpired agreement. Required
   * agreements issued ad hoc (no template) count too.
   */
  async clearance(orgId: string, vendorId: string, now = new Date()): Promise<Clearance> {
    const vendor = await this.requireVendor(orgId, vendorId);
    const [templates, agreements] = await Promise.all([
      this.listTemplates(orgId),
      this.agreements.find({ where: { organizationId: orgId, vendorId, isDeleted: false }, order: { createdAt: 'DESC' } }),
    ]);

    const items: ClearanceItem[] = [];
    const covered = new Set<string>();

    for (const t of templates.filter((x) => x.required && this.appliesTo(x, vendor))) {
      const live = agreements.find((a) => a.templateId === t.id && a.status !== 'void');
      if (live) covered.add(live.id);
      items.push({
        templateId: t.id,
        agreementId: live?.id ?? null,
        title: live?.title ?? t.title ?? t.name,
        status: live ? this.effectiveStatus(live, now) : 'missing',
        waivedReason: live?.waivedReason ?? null,
        waivedBy: live?.waivedBy ?? null,
        signedAt: live?.signedAt ?? null,
        expiresAt: live?.expiresAt ?? null,
      });
    }

    // Required agreements raised for this vendor alone, or from a template that
    // has since been archived or made optional — still binding on the vendor.
    for (const a of agreements) {
      if (!a.requiredForOnboarding || a.status === 'void' || covered.has(a.id)) continue;
      items.push({
        templateId: a.templateId,
        agreementId: a.id,
        title: a.title,
        status: this.effectiveStatus(a, now),
        waivedReason: a.waivedReason,
        waivedBy: a.waivedBy,
        signedAt: a.signedAt,
        expiresAt: a.expiresAt,
      });
    }

    // Waived counts as settled: the vendor is cleared without the signature.
    const outstanding = items.filter((i) => i.status !== 'signed' && i.status !== 'waived').length;
    return { cleared: outstanding === 0, items, outstanding };
  }

  /**
   * Keep `onboardingStatus` in step with clearance, so nobody has to remember to
   * move it by hand. A suspended vendor is left alone: suspension is a decision,
   * not a consequence of paperwork.
   */
  private async syncOnboarding(orgId: string, vendorId: string): Promise<void> {
    const vendor = await this.requireVendor(orgId, vendorId);
    if (vendor.onboardingStatus === 'suspended') return;
    const { cleared, items } = await this.clearance(orgId, vendorId);
    const next = cleared ? 'active' : items.length ? 'agreements_pending' : 'invited';
    if (vendor.onboardingStatus === next) return;
    vendor.onboardingStatus = next;
    if (next === 'active' && !vendor.onboardedAt) vendor.onboardedAt = new Date();
    await this.vendors.save(vendor);
  }

  /**
   * A waiver outranks everything except an actual signature; a signed agreement
   * past its expiry no longer clears the vendor.
   */
  private effectiveStatus(a: VendorAgreementEntity, now: Date): ClearanceItem['status'] {
    if (a.status === 'signed') {
      return a.expiresAt && a.expiresAt.getTime() <= now.getTime() ? 'expired' : 'signed';
    }
    if (a.waived) return 'waived';
    return a.status;
  }

  /** Empty `appliesToCategories` means every vendor. */
  private appliesTo(t: VendorAgreementTemplateEntity, vendor: VendorEntity): boolean {
    const only = t.appliesToCategories ?? [];
    if (only.length === 0) return true;
    return only.some((c) => c.toLowerCase() === (vendor.serviceCategory ?? '').toLowerCase());
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private requireContent(bodyHtml?: string | null, sourceFileId?: string | null): void {
    if (!bodyHtml?.trim() && !sourceFileId) throw new BadRequestException('Provide agreement text or attach a PDF');
  }

  private async requireVendor(orgId: string, vendorId: string): Promise<VendorEntity> {
    const vendor = await this.vendors.findOne({ where: { id: vendorId, organizationId: orgId, isDeleted: false } });
    if (!vendor) throw new NotFoundException('Vendor not found');
    return vendor;
  }

  private async requireTemplate(orgId: string, templateId: string): Promise<VendorAgreementTemplateEntity> {
    const t = await this.templates.findOne({ where: { id: templateId, organizationId: orgId, isDeleted: false } });
    if (!t) throw new NotFoundException('Agreement template not found');
    return t;
  }

  private async requireAgreement(orgId: string, vendorId: string, id: string): Promise<VendorAgreementEntity> {
    const a = await this.agreements.findOne({ where: { id, organizationId: orgId, vendorId, isDeleted: false } });
    if (!a) throw new NotFoundException('Agreement not found');
    return a;
  }
}
