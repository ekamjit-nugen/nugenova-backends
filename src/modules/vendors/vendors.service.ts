import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, In, Repository } from 'typeorm';

import { VendorEntity } from './entities/vendor.entity';
import { VendorContactEntity } from './entities/vendor-contact.entity';
import { VendorEmployeeEntity } from './entities/vendor-employee.entity';
import {
  CreateVendorContactDto, CreateVendorDto, CreateVendorEmployeeDto,
  UpdateVendorContactDto, UpdateVendorDto, UpdateVendorEmployeeDto,
} from './dto';

export interface VendorsCaller {
  userId: string;
  orgId: string;
  isAdmin: boolean;
}

/**
 * Vendors — the supplier side of the delivery model: staffing partners and
 * subcontractors, the people they supply, and the contacts we deal with.
 *
 * Everything is org-scoped and soft-deleted, mirroring Clients. Contractors are
 * deliberately NOT org members: they live in `vendor_employees`, so they never
 * reach payroll, the attendance roster or headcount. Agreements, bills and the
 * vendor portal are later phases; this is the record of who we buy from.
 */
@Injectable()
export class VendorsService {
  constructor(
    @InjectRepository(VendorEntity) private readonly vendors: Repository<VendorEntity>,
    @InjectRepository(VendorContactEntity) private readonly contacts: Repository<VendorContactEntity>,
    @InjectRepository(VendorEmployeeEntity) private readonly people: Repository<VendorEmployeeEntity>,
  ) {}

  // ── vendors ────────────────────────────────────────────────────────────────

  async create(caller: VendorsCaller, dto: CreateVendorDto): Promise<VendorEntity> {
    const companyName = dto.companyName.trim();
    const dup = await this.vendors.findOne({ where: { organizationId: caller.orgId, companyName: ILike(companyName), isDeleted: false } });
    if (dup) throw new ConflictException('A vendor with this company name already exists');
    return this.vendors.save(this.vendors.create({
      organizationId: caller.orgId,
      companyName,
      displayName: dto.displayName?.trim() || null,
      serviceCategory: dto.serviceCategory?.trim() || 'other',
      website: dto.website ?? null,
      taxId: dto.taxId ?? null,
      currency: dto.currency?.toUpperCase() || 'INR',
      status: 'active',
      onboardingStatus: 'invited',
      onboardedAt: null,
      timeTrackingEnabled: dto.timeTrackingEnabled ?? false,
      billingAddress: dto.billingAddress ?? null,
      primaryContact: dto.primaryContact ?? null,
      tags: dto.tags ?? [],
      notes: dto.notes ?? null,
      createdBy: caller.userId,
      updatedBy: caller.userId,
      isDeleted: false,
    }));
  }

  /** The vendor list, each row carrying the counts the cards show. */
  async list(orgId: string, q: { status?: string; q?: string; category?: string; tag?: string }) {
    const where: Record<string, unknown> = { organizationId: orgId, isDeleted: false };
    if (q.status === 'active' || q.status === 'inactive' || q.status === 'archived') where.status = q.status;
    if (q.category) where.serviceCategory = q.category;
    if (q.q) where.companyName = ILike(`%${q.q}%`);
    const rows = await this.vendors.find({ where, order: { createdAt: 'DESC' } });
    const filtered = q.tag ? rows.filter((v) => (v.tags ?? []).includes(q.tag as string)) : rows;

    const ids = filtered.map((v) => v.id);
    const [contacts, people] = ids.length
      ? await Promise.all([
          this.contacts.find({ where: { vendorId: In(ids), isDeleted: false } }),
          this.people.find({ where: { vendorId: In(ids), isDeleted: false } }),
        ])
      : [[], []];
    const tally = (arr: Array<{ vendorId: string }>) =>
      arr.reduce((m, r) => m.set(r.vendorId, (m.get(r.vendorId) || 0) + 1), new Map<string, number>());
    const c = tally(contacts);
    const p = tally(people.filter((e) => e.status === 'active'));
    return filtered.map((v) => ({ ...v, counts: { contacts: c.get(v.id) || 0, activePeople: p.get(v.id) || 0 } }));
  }

  /** One vendor with its contacts and people — the detail page in a single call. */
  async get(orgId: string, vendorId: string) {
    const vendor = await this.requireVendor(orgId, vendorId);
    const [contacts, people] = await Promise.all([
      this.contacts.find({ where: { organizationId: orgId, vendorId, isDeleted: false }, order: { isPrimary: 'DESC', createdAt: 'ASC' } }),
      this.people.find({ where: { organizationId: orgId, vendorId, isDeleted: false }, order: { createdAt: 'DESC' } }),
    ]);
    return { ...vendor, contacts, people };
  }

  async update(caller: VendorsCaller, vendorId: string, dto: UpdateVendorDto): Promise<VendorEntity> {
    const vendor = await this.requireVendor(caller.orgId, vendorId);
    if (dto.companyName !== undefined) {
      const companyName = dto.companyName.trim();
      const dup = await this.vendors.findOne({ where: { organizationId: caller.orgId, companyName: ILike(companyName), isDeleted: false } });
      if (dup && dup.id !== vendorId) throw new ConflictException('A vendor with this company name already exists');
      vendor.companyName = companyName;
    }
    if (dto.displayName !== undefined) vendor.displayName = dto.displayName?.trim() || null;
    if (dto.serviceCategory !== undefined) vendor.serviceCategory = dto.serviceCategory?.trim() || 'other';
    if (dto.website !== undefined) vendor.website = dto.website ?? null;
    if (dto.taxId !== undefined) vendor.taxId = dto.taxId ?? null;
    if (dto.currency !== undefined) vendor.currency = dto.currency?.toUpperCase() || vendor.currency;
    if (dto.timeTrackingEnabled !== undefined) vendor.timeTrackingEnabled = dto.timeTrackingEnabled;
    if (dto.billingAddress !== undefined) vendor.billingAddress = dto.billingAddress ?? null;
    if (dto.primaryContact !== undefined) vendor.primaryContact = dto.primaryContact ?? null;
    if (dto.tags !== undefined) vendor.tags = dto.tags ?? [];
    if (dto.notes !== undefined) vendor.notes = dto.notes ?? null;
    if (dto.status !== undefined) vendor.status = dto.status;
    if (dto.onboardingStatus !== undefined) {
      vendor.onboardingStatus = dto.onboardingStatus;
      // Stamp the date the first time a vendor is cleared to supply people.
      if (dto.onboardingStatus === 'active' && !vendor.onboardedAt) vendor.onboardedAt = new Date();
    }
    vendor.updatedBy = caller.userId;
    return this.vendors.save(vendor);
  }

  /**
   * Soft-delete a vendor and everything under it, so a later vendor of the same
   * name starts clean and no orphan contractor keeps showing up in pickers.
   */
  async remove(caller: VendorsCaller, vendorId: string): Promise<{ id: string }> {
    const vendor = await this.requireVendor(caller.orgId, vendorId);
    vendor.isDeleted = true;
    vendor.updatedBy = caller.userId;
    await this.vendors.save(vendor);
    await Promise.all([
      this.contacts.update({ organizationId: caller.orgId, vendorId }, { isDeleted: true }),
      this.people.update({ organizationId: caller.orgId, vendorId }, { isDeleted: true }),
    ]);
    return { id: vendorId };
  }

  /** Header numbers for the vendors page. */
  async stats(orgId: string) {
    const [vendors, people] = await Promise.all([
      this.vendors.find({ where: { organizationId: orgId, isDeleted: false } }),
      this.people.find({ where: { organizationId: orgId, isDeleted: false } }),
    ]);
    const live = new Set(vendors.filter((v) => v.status === 'active').map((v) => v.id));
    return {
      total: vendors.length,
      active: live.size,
      onboardingPending: vendors.filter((v) => v.onboardingStatus === 'invited' || v.onboardingStatus === 'agreements_pending').length,
      suspended: vendors.filter((v) => v.onboardingStatus === 'suspended').length,
      // Only people from a live vendor count as supplied resources.
      people: people.filter((p) => p.status === 'active' && live.has(p.vendorId)).length,
    };
  }

  /** Service categories already in use, for the filter and the create form. */
  async categories(orgId: string): Promise<string[]> {
    const rows = await this.vendors.find({ where: { organizationId: orgId, isDeleted: false }, select: { serviceCategory: true } });
    return [...new Set(rows.map((r) => r.serviceCategory).filter(Boolean))].sort();
  }

  // ── contacts ───────────────────────────────────────────────────────────────

  async addContact(orgId: string, vendorId: string, dto: CreateVendorContactDto): Promise<VendorContactEntity> {
    await this.requireVendor(orgId, vendorId);
    if (dto.isPrimary) await this.clearPrimary(orgId, vendorId);
    return this.contacts.save(this.contacts.create({
      organizationId: orgId,
      vendorId,
      name: dto.name.trim(),
      email: dto.email?.toLowerCase() ?? null,
      phone: dto.phone ?? null,
      designation: dto.designation ?? null,
      isPrimary: dto.isPrimary ?? false,
      userId: null,
      isDeleted: false,
    }));
  }

  async updateContact(orgId: string, vendorId: string, contactId: string, dto: UpdateVendorContactDto): Promise<VendorContactEntity> {
    const contact = await this.contacts.findOne({ where: { id: contactId, organizationId: orgId, vendorId, isDeleted: false } });
    if (!contact) throw new NotFoundException('Contact not found');
    if (dto.isPrimary) await this.clearPrimary(orgId, vendorId);
    if (dto.name !== undefined) contact.name = dto.name.trim();
    if (dto.email !== undefined) contact.email = dto.email?.toLowerCase() ?? null;
    if (dto.phone !== undefined) contact.phone = dto.phone ?? null;
    if (dto.designation !== undefined) contact.designation = dto.designation ?? null;
    if (dto.isPrimary !== undefined) contact.isPrimary = dto.isPrimary;
    return this.contacts.save(contact);
  }

  async removeContact(orgId: string, vendorId: string, contactId: string): Promise<{ id: string }> {
    const res = await this.contacts.update({ id: contactId, organizationId: orgId, vendorId }, { isDeleted: true });
    if (!res.affected) throw new NotFoundException('Contact not found');
    return { id: contactId };
  }

  // ── vendor employees (contractors) ─────────────────────────────────────────

  async addEmployee(orgId: string, vendorId: string, dto: CreateVendorEmployeeDto): Promise<VendorEmployeeEntity> {
    await this.requireVendor(orgId, vendorId);
    const email = dto.email?.toLowerCase() ?? null;
    if (email) {
      // The same person supplied twice by one vendor is a duplicate; the same
      // person from a DIFFERENT vendor is legitimate (they changed agency).
      const dup = await this.people.findOne({ where: { organizationId: orgId, vendorId, email, isDeleted: false } });
      if (dup) throw new ConflictException('This vendor already has someone with that email');
    }
    return this.people.save(this.people.create({
      organizationId: orgId,
      vendorId,
      name: dto.name.trim(),
      email,
      phone: dto.phone ?? null,
      designation: dto.designation ?? null,
      skills: dto.skills ?? [],
      employmentType: dto.employmentType ?? 'contract',
      status: dto.status ?? 'active',
      rateAmount: dto.rateAmount ?? null,
      rateCurrency: dto.rateCurrency?.toUpperCase() || 'INR',
      rateUnit: dto.rateUnit ?? 'day',
      linkedUserId: null,
      notes: dto.notes ?? null,
      isDeleted: false,
    }));
  }

  async listEmployees(orgId: string, vendorId: string, q: { status?: string; q?: string; skill?: string }) {
    await this.requireVendor(orgId, vendorId);
    const where: Record<string, unknown> = { organizationId: orgId, vendorId, isDeleted: false };
    if (q.status === 'active' || q.status === 'inactive') where.status = q.status;
    if (q.q) where.name = ILike(`%${q.q}%`);
    const rows = await this.people.find({ where, order: { createdAt: 'DESC' } });
    if (!q.skill) return rows;
    const skill = q.skill.toLowerCase();
    return rows.filter((r) => (r.skills ?? []).some((s) => s.toLowerCase() === skill));
  }

  async updateEmployee(orgId: string, vendorId: string, employeeId: string, dto: UpdateVendorEmployeeDto): Promise<VendorEmployeeEntity> {
    const person = await this.people.findOne({ where: { id: employeeId, organizationId: orgId, vendorId, isDeleted: false } });
    if (!person) throw new NotFoundException('Vendor employee not found');
    if (dto.name !== undefined) person.name = dto.name.trim();
    if (dto.email !== undefined) person.email = dto.email?.toLowerCase() ?? null;
    if (dto.phone !== undefined) person.phone = dto.phone ?? null;
    if (dto.designation !== undefined) person.designation = dto.designation ?? null;
    if (dto.skills !== undefined) person.skills = dto.skills ?? [];
    if (dto.employmentType !== undefined) person.employmentType = dto.employmentType;
    if (dto.status !== undefined) person.status = dto.status;
    if (dto.rateAmount !== undefined) person.rateAmount = dto.rateAmount ?? null;
    if (dto.rateCurrency !== undefined) person.rateCurrency = dto.rateCurrency?.toUpperCase() || person.rateCurrency;
    if (dto.rateUnit !== undefined) person.rateUnit = dto.rateUnit;
    if (dto.notes !== undefined) person.notes = dto.notes ?? null;
    return this.people.save(person);
  }

  async removeEmployee(orgId: string, vendorId: string, employeeId: string): Promise<{ id: string }> {
    const res = await this.people.update({ id: employeeId, organizationId: orgId, vendorId }, { isDeleted: true });
    if (!res.affected) throw new NotFoundException('Vendor employee not found');
    return { id: employeeId };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async requireVendor(orgId: string, vendorId: string): Promise<VendorEntity> {
    const vendor = await this.vendors.findOne({ where: { id: vendorId, organizationId: orgId, isDeleted: false } });
    if (!vendor) throw new NotFoundException('Vendor not found');
    return vendor;
  }

  /** Only one contact per vendor is primary. */
  private async clearPrimary(orgId: string, vendorId: string): Promise<void> {
    await this.contacts.update({ organizationId: orgId, vendorId, isPrimary: true }, { isPrimary: false });
  }
}
