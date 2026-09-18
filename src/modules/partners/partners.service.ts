import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, In, Repository } from 'typeorm';

import { PartnerCategory, PartnerEntity } from './entities/partner.entity';
import { ClientEntity } from '../clients/entities/client.entity';
import { VendorEntity } from '../vendors/entities/vendor.entity';
import { PartnerContactEntity } from './entities/partner-contact.entity';
import { ClientAssignmentEntity } from '../clients/entities/client-assignment.entity';
import { VendorEmployeeEntity } from '../vendors/entities/vendor-employee.entity';
import { CreatePartnerDto, UpdatePartnerDto } from './dto';

export interface PartnersCaller {
  userId: string;
  orgId: string;
  isAdmin: boolean;
}

/**
 * Partners — the companies an org works with, on either side:
 *
 *   • **client** — we supply people to them;
 *   • **vendor** — they supply people to us.
 *
 * One list, one detail, one record. The category decides which way people flow
 * and which extras the company carries (bills and supplied people on a vendor;
 * tickets, shared boards and a delivery team on a client), while the profile,
 * contacts, documents, agreements and portal are identical either way.
 *
 * The category-specific services (ClientsService, VendorsService) still own
 * their own behaviour — this is the shared spine they sit on, and what the
 * combined Partners screen reads.
 */
@Injectable()
export class PartnersService {
  constructor(
    @InjectRepository(PartnerEntity) private readonly partners: Repository<PartnerEntity>,
    // Writes go through the child repositories: they are what set the `category`
    // discriminator. Reads use the base repository, which returns both.
    @InjectRepository(ClientEntity) private readonly clients: Repository<ClientEntity>,
    @InjectRepository(VendorEntity) private readonly vendors: Repository<VendorEntity>,
    @InjectRepository(PartnerContactEntity) private readonly contacts: Repository<PartnerContactEntity>,
    @InjectRepository(ClientAssignmentEntity) private readonly assignments: Repository<ClientAssignmentEntity>,
    @InjectRepository(VendorEmployeeEntity) private readonly suppliedPeople: Repository<VendorEmployeeEntity>,
  ) {}

  /** Every partner, or one category of them, with the counts each card shows. */
  async list(orgId: string, q: { category?: string; status?: string; q?: string; tag?: string } = {}) {
    const where: Record<string, unknown> = { organizationId: orgId, isDeleted: false };
    if (this.isCategory(q.category)) where.category = q.category;
    if (q.status && q.status !== 'all') where.status = q.status;
    if (q.q) where.companyName = ILike(`%${q.q}%`);

    const rows = await this.partners.find({ where, order: { createdAt: 'DESC' } });
    const filtered = q.tag ? rows.filter((p) => (p.tags ?? []).includes(q.tag as string)) : rows;
    const ids = filtered.map((p) => p.id);
    if (!ids.length) return [];

    const [partnerContacts, assignments, supplied] = await Promise.all([
      // One table now, whichever side the partner is on.
      this.contacts.find({ where: { partnerId: In(ids), isDeleted: false } }),
      this.assignments.find({ where: { clientId: In(ids) } }),
      this.suppliedPeople.find({ where: { vendorId: In(ids), isDeleted: false } }),
    ]);

    const tally = <T>(arr: T[], key: (row: T) => string) =>
      arr.reduce((m, r) => m.set(key(r), (m.get(key(r)) || 0) + 1), new Map<string, number>());
    const contacts = tally(partnerContacts, (c) => c.partnerId);
    const team = tally(assignments, (a) => a.clientId);
    const people = tally(supplied.filter((p) => p.status === 'active'), (p) => p.vendorId);

    return filtered.map((p) => ({
      ...this.view(p),
      counts: {
        contacts: contacts.get(p.id) || 0,
        /**
         * The direction that matters for this partner: staff we have assigned to
         * a client, or contractors a vendor supplies us.
         */
        people: p.category === 'vendor' ? people.get(p.id) || 0 : team.get(p.id) || 0,
      },
    }));
  }

  async get(orgId: string, id: string) {
    return this.view(await this.require(orgId, id));
  }

  /** Header numbers for the combined page. */
  async stats(orgId: string) {
    const rows = await this.partners.find({ where: { organizationId: orgId, isDeleted: false } });
    const live = rows.filter((p) => p.status === 'active');
    return {
      total: rows.length,
      clients: rows.filter((p) => p.category === 'client').length,
      vendors: rows.filter((p) => p.category === 'vendor').length,
      active: live.length,
      portalOpen: rows.filter((p) => p.portalEnabled).length,
    };
  }

  /**
   * Add a partner. The category is chosen here and never changes afterwards:
   * it decides which way people flow, and the company's children (bills, tickets)
   * are built on that assumption.
   */
  async create(caller: PartnersCaller, dto: CreatePartnerDto) {
    if (!this.isCategory(dto.category)) throw new BadRequestException('Choose whether this is a client or a vendor');
    const companyName = dto.companyName.trim();
    const dup = await this.partners.findOne({
      where: { organizationId: caller.orgId, category: dto.category, companyName: ILike(companyName), isDeleted: false },
    });
    if (dup) throw new ConflictException(`A ${dto.category} with this company name already exists`);

    const repo = this.repoFor(dto.category);
    const partner = repo.create({
      organizationId: caller.orgId,
      companyName,
      displayName: dto.displayName?.trim() || null,
      website: dto.website ?? null,
      status: 'active',
      tags: dto.tags ?? [],
      notes: dto.notes ?? null,
      primaryContact: dto.primaryContact ?? null,
      portalEnabled: false,
      createdBy: caller.userId,
      updatedBy: caller.userId,
      isDeleted: false,
      ...(dto.category === 'client'
        ? { industry: dto.sector ?? null }
        : {
            serviceCategory: dto.sector?.trim() || 'other',
            taxId: dto.taxId ?? null,
            currency: dto.currency?.toUpperCase() || 'INR',
            onboardingStatus: 'invited',
            onboardedAt: null,
            timeTrackingEnabled: false,
            billingAddress: dto.billingAddress ?? null,
          }),
    } as Partial<PartnerEntity>);
    return this.view(await repo.save(partner));
  }

  /** The profile fields both sides share. Category-specific edits stay in their own service. */
  async update(caller: PartnersCaller, id: string, dto: UpdatePartnerDto) {
    const partner = await this.require(caller.orgId, id);
    if (dto.companyName !== undefined) {
      const companyName = dto.companyName.trim();
      const dup = await this.partners.findOne({
        where: { organizationId: caller.orgId, category: partner.category, companyName: ILike(companyName), isDeleted: false },
      });
      if (dup && dup.id !== id) throw new ConflictException(`A ${partner.category} with this company name already exists`);
      partner.companyName = companyName;
    }
    if (dto.displayName !== undefined) partner.displayName = dto.displayName?.trim() || null;
    if (dto.website !== undefined) partner.website = dto.website ?? null;
    if (dto.tags !== undefined) partner.tags = dto.tags ?? [];
    if (dto.notes !== undefined) partner.notes = dto.notes ?? null;
    if (dto.primaryContact !== undefined) partner.primaryContact = dto.primaryContact ?? null;
    if (dto.status !== undefined) partner.status = dto.status;
    if (dto.sector !== undefined) {
      // Same idea, different word on each side: a client's industry, a vendor's service.
      const row = partner as PartnerEntity & { industry?: string | null; serviceCategory?: string };
      if (partner.category === 'client') row.industry = dto.sector ?? null;
      else row.serviceCategory = dto.sector?.trim() || 'other';
    }
    partner.updatedBy = caller.userId;
    return this.view(await this.repoFor(partner.category).save(partner));
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /**
   * The child repository for a category — saving through it is what sets the
   * `category` discriminator. Typed as the base repository because the caller
   * only ever touches shared fields; the category-specific ones are spread in.
   */
  private repoFor(category: PartnerCategory): Repository<PartnerEntity> {
    return (category === 'client' ? this.clients : this.vendors) as unknown as Repository<PartnerEntity>;
  }

  private isCategory(c?: string): c is PartnerCategory {
    return c === 'client' || c === 'vendor';
  }

  private async require(orgId: string, id: string): Promise<PartnerEntity> {
    const partner = await this.partners.findOne({ where: { id, organizationId: orgId, isDeleted: false } });
    if (!partner) throw new NotFoundException('Partner not found');
    return partner;
  }

  /** One shape for both sides, so a combined list needs no branching to render. */
  private view(p: PartnerEntity) {
    const row = p as PartnerEntity & {
      industry?: string | null; serviceCategory?: string; taxId?: string | null; currency?: string;
      onboardingStatus?: string; onboardedAt?: Date | null; timeTrackingEnabled?: boolean;
    };
    return {
      id: p.id,
      category: p.category,
      companyName: p.companyName,
      displayName: p.displayName,
      /** A client's industry or a vendor's service category — the same field to a reader. */
      sector: p.category === 'client' ? row.industry ?? null : row.serviceCategory ?? null,
      website: p.website,
      status: p.status,
      tags: p.tags ?? [],
      notes: p.notes,
      primaryContact: p.primaryContact,
      portalEnabled: p.portalEnabled,
      createdAt: p.createdAt,
      // Vendor-only, left out for a client rather than sent as nulls to confuse.
      ...(p.category === 'vendor'
        ? {
            taxId: row.taxId ?? null,
            currency: row.currency ?? 'INR',
            onboardingStatus: row.onboardingStatus ?? 'invited',
            onboardedAt: row.onboardedAt ?? null,
            timeTrackingEnabled: !!row.timeTrackingEnabled,
          }
        : {}),
    };
  }
}
