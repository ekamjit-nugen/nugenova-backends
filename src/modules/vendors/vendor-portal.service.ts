import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';

import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { MailService } from '../../bootstrap/mail/mail.service';
import { vendorPortalInviteEmail } from '../../bootstrap/mail/email-layout';
import { VendorEntity } from './entities/vendor.entity';
import { VendorContactEntity } from './entities/vendor-contact.entity';
import { VendorEmployeeEntity } from './entities/vendor-employee.entity';
import { VendorAgreementEntity } from './entities/vendor-agreement.entity';
import { VendorBillEntity } from './entities/vendor-bill.entity';
import { VendorAgreementsService } from './vendor-agreements.service';
import { VendorBillsService } from './vendor-bills.service';
import { VendorDocumentsService } from './vendor-documents.service';
import { VendorsCaller } from './vendors.service';
import {
  CreateVendorEmployeeDto, InviteVendorContactDto, PortalSignAgreementDto, SignVendorDocumentDto, UpdateVendorEmployeeDto,
} from './dto';

/**
 * The vendor's own view of us — the outside half of the vendor module.
 *
 * A portal user is an OrgMembership with `role='vendor'`, `personType='vendor'`
 * and a `vendorId`, exactly as a client portal user is a `client` membership.
 * `personType='vendor'` is what keeps them out of `staffScope()` — payroll, the
 * attendance roster, headcount and the Directory never see them.
 *
 * Everything here is scoped by the caller's own membership: a vendor user can
 * only ever reach their own vendor's rows, and there is no id in any route that
 * could point somewhere else.
 *
 * What a vendor may NOT do, deliberately:
 *   • change a rate — that is a commercial term agreed with us, so rates are
 *     read-only here even though they can add and edit their own people;
 *   • see a draft bill or a draft agreement — a draft is our working copy.
 */
@Injectable()
export class VendorPortalService {
  constructor(
    @InjectRepository(VendorEntity) private readonly vendors: Repository<VendorEntity>,
    @InjectRepository(VendorContactEntity) private readonly contacts: Repository<VendorContactEntity>,
    @InjectRepository(VendorEmployeeEntity) private readonly people: Repository<VendorEmployeeEntity>,
    @InjectRepository(VendorAgreementEntity) private readonly agreementRows: Repository<VendorAgreementEntity>,
    @InjectRepository(VendorBillEntity) private readonly billRows: Repository<VendorBillEntity>,
    @InjectRepository(OrgMembershipEntity) private readonly memberships: Repository<OrgMembershipEntity>,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    private readonly agreements: VendorAgreementsService,
    private readonly bills: VendorBillsService,
    private readonly documents: VendorDocumentsService,
    @Optional() private readonly mail?: MailService,
  ) {}

  // ── giving access (staff side) ─────────────────────────────────────────────

  /**
   * Turn a vendor contact into a portal login. Same shape as the client portal
   * invite: the person signs in with their email and the OTP flow, so no
   * password is ever set or sent here.
   */
  async invite(caller: VendorsCaller, vendorId: string, contactId: string, dto: InviteVendorContactDto) {
    const orgId = caller.orgId;
    const vendor = await this.requireVendor(orgId, vendorId);
    const contact = await this.contacts.findOne({ where: { id: contactId, vendorId, organizationId: orgId, isDeleted: false } });
    if (!contact) throw new NotFoundException('Contact not found');
    if (!contact.email) throw new BadRequestException('Add an email to this contact before inviting them to the portal');
    const email = contact.email.toLowerCase();

    let user = await this.users.findOne({ where: { email } });
    if (!user) {
      user = await this.users.save(this.users.create({
        email,
        password: 'pending-otp-' + randomUUID(),
        firstName: dto.firstName || contact.name.split(' ')[0] || 'Vendor',
        lastName: dto.lastName || contact.name.split(' ').slice(1).join(' ') || '',
        isActive: true,
        setupStage: 'complete',
      }));
    }

    // This person must not already be in THIS org as something else: a staff
    // member turned vendor login would carry staff access into the portal.
    const existing = await this.memberships.findOne({ where: { organizationId: orgId, userId: user.id } });
    if (existing) {
      if (existing.role !== 'vendor') throw new ConflictException('This email is already a member of this organization');
      if (existing.vendorId && existing.vendorId !== vendorId) throw new ConflictException('This email is already a portal user of another vendor');
      existing.status = 'active';
      existing.vendorId = vendorId;
      existing.personType = 'vendor';
      await this.memberships.save(existing);
    } else {
      await this.memberships.save(this.memberships.create({
        userId: user.id,
        email,
        organizationId: orgId,
        role: 'vendor',
        personType: 'vendor',
        vendorId,
        status: 'active',
        invitedBy: caller.userId,
        joinedAt: new Date(),
      }));
    }

    const orgs = new Set(user.organizations || []);
    orgs.add(orgId);
    user.organizations = [...orgs];
    if (!user.defaultOrganizationId) user.defaultOrganizationId = orgId;
    await this.users.save(user);

    contact.userId = user.id;
    await this.contacts.save(contact);

    const invite = vendorPortalInviteEmail({ contactName: contact.name, companyName: vendor.companyName });
    void this.mail?.send({
      to: email,
      subject: invite.subject,
      html: invite.html,
      category: 'vendors.portal_invite',
    }).catch(() => undefined);

    return { contactId: contact.id, userId: user.id, email };
  }

  /** Take portal access away again, leaving the contact record intact. */
  async revoke(orgId: string, vendorId: string, contactId: string) {
    const contact = await this.contacts.findOne({ where: { id: contactId, vendorId, organizationId: orgId, isDeleted: false } });
    if (!contact) throw new NotFoundException('Contact not found');
    if (!contact.userId) throw new BadRequestException('This contact does not have portal access');
    const membership = await this.memberships.findOne({ where: { organizationId: orgId, userId: contact.userId, role: 'vendor' } });
    if (membership) {
      membership.status = 'inactive';
      await this.memberships.save(membership);
    }
    contact.userId = null;
    await this.contacts.save(contact);
    return { contactId: contact.id };
  }

  /** Who has portal access at this vendor. */
  async portalUsers(orgId: string, vendorId: string) {
    const contacts = await this.contacts.find({ where: { organizationId: orgId, vendorId, isDeleted: false } });
    return contacts.filter((c) => !!c.userId).map((c) => ({ contactId: c.id, name: c.name, email: c.email, userId: c.userId }));
  }

  // ── the vendor's own view ──────────────────────────────────────────────────

  /** Portal home: who they are to us, what we still need, and what we owe. */
  async overview(orgId: string, userId: string) {
    const vendor = await this.callerVendor(orgId, userId);
    const [clearance, cost, people] = await Promise.all([
      this.agreements.clearance(orgId, vendor.id),
      this.bills.costSummary(orgId, vendor.id),
      this.people.count({ where: { organizationId: orgId, vendorId: vendor.id, status: 'active', isDeleted: false } }),
    ]);
    return {
      vendor: {
        id: vendor.id,
        companyName: vendor.companyName,
        displayName: vendor.displayName,
        serviceCategory: vendor.serviceCategory,
        status: vendor.status,
        onboardingStatus: vendor.onboardingStatus,
        currency: vendor.currency,
      },
      clearance: { cleared: clearance.cleared, outstanding: clearance.outstanding },
      /** Bills we have approved but not paid — what they are waiting on. */
      awaitingPayment: cost.outstanding,
      paidToDate: cost.paid,
      peopleSupplied: people,
    };
  }

  /** The agreements that have reached them — never our drafts. */
  async agreementsForCaller(orgId: string, userId: string) {
    const vendor = await this.callerVendor(orgId, userId);
    const rows = await this.agreementRows.find({
      where: { organizationId: orgId, vendorId: vendor.id, isDeleted: false },
      order: { createdAt: 'DESC' },
    });
    return rows.filter((a) => a.status !== 'draft').map((a) => this.agreementView(a));
  }

  /**
   * The vendor signs for themselves. Unlike the staff-side record-a-signature,
   * this is the real thing: the signer is the person signed in, and only an
   * agreement actually sent to them can be signed.
   */
  async signAgreement(orgId: string, userId: string, agreementId: string, dto: PortalSignAgreementDto, ip?: string, ua?: string) {
    const vendor = await this.callerVendor(orgId, userId);
    const agreement = await this.agreementRows.findOne({ where: { id: agreementId, organizationId: orgId, vendorId: vendor.id, isDeleted: false } });
    if (!agreement) throw new NotFoundException('Agreement not found');
    if (agreement.status === 'draft') throw new NotFoundException('Agreement not found'); // not sent yet: it doesn't exist to them
    if (agreement.status !== 'sent') throw new BadRequestException(`This agreement cannot be signed — it is ${agreement.status}`);

    const caller: VendorsCaller = { userId, orgId, isAdmin: false };
    const signed = await this.agreements.sign(
      caller,
      vendor.id,
      agreementId,
      {
        signerName: dto.signerName,
        signerEmail: dto.signerEmail,
        // Signed in the app by the vendor themselves — never `offline`, which
        // means a staff member recorded it on their behalf.
        method: dto.signatureFileId ? 'drawn' : 'typed',
        signatureFileId: dto.signatureFileId,
        fieldValues: dto.fieldValues,
      },
      ip,
      ua,
    );
    return this.agreementView(signed);
  }

  /** Bills we have agreed — a draft is still our working copy. */
  async billsForCaller(orgId: string, userId: string) {
    const vendor = await this.callerVendor(orgId, userId);
    const rows = await this.billRows.find({
      where: { organizationId: orgId, vendorId: vendor.id, isDeleted: false },
      order: { createdAt: 'DESC' },
    });
    return rows
      .filter((b) => b.status !== 'draft')
      .map((b) => ({
        id: b.id,
        billNumber: b.billNumber,
        vendorInvoiceNumber: b.vendorInvoiceNumber,
        period: b.period,
        lineItems: b.lineItems ?? [],
        currency: b.currency,
        subtotal: Number(b.subtotal),
        taxPercent: Number(b.taxPercent),
        taxAmount: Number(b.taxAmount),
        total: Number(b.total),
        status: b.status,
        issueDate: b.issueDate,
        dueDate: b.dueDate,
        paidAt: b.paidAt,
        paymentReference: b.paymentReference,
        cancelReason: b.cancelReason,
      }));
  }

  /** Documents we shared with them; they can read and sign, never send. */
  async documentsForCaller(orgId: string, userId: string) {
    const vendor = await this.callerVendor(orgId, userId);
    return this.documents.forVendor(orgId, vendor.id);
  }

  async signDocument(orgId: string, userId: string, docId: string, dto: SignVendorDocumentDto, ip?: string, ua?: string) {
    const vendor = await this.callerVendor(orgId, userId);
    return this.documents.signAsVendor(orgId, vendor.id, userId, docId, dto, ip, ua);
  }

  /** The people they supply us — their roster to keep current. */
  async peopleForCaller(orgId: string, userId: string) {
    const vendor = await this.callerVendor(orgId, userId);
    return this.people.find({ where: { organizationId: orgId, vendorId: vendor.id, isDeleted: false }, order: { createdAt: 'DESC' } });
  }

  async addPerson(orgId: string, userId: string, dto: CreateVendorEmployeeDto) {
    const vendor = await this.callerVendor(orgId, userId);
    // Rates are ours to agree, not theirs to set: a vendor adding someone gets
    // no rate at all, and we fill it in once it has been agreed.
    const { rateAmount, rateCurrency, rateUnit, ...rest } = dto;
    return this.people.save(this.people.create({
      organizationId: orgId,
      vendorId: vendor.id,
      name: rest.name.trim(),
      email: rest.email?.toLowerCase() ?? null,
      phone: rest.phone ?? null,
      designation: rest.designation ?? null,
      skills: rest.skills ?? [],
      employmentType: rest.employmentType ?? 'contract',
      status: rest.status ?? 'active',
      rateAmount: null,
      rateCurrency: vendor.currency,
      rateUnit: 'day',
      linkedUserId: null,
      notes: rest.notes ?? null,
      isDeleted: false,
    }));
  }

  async updatePerson(orgId: string, userId: string, employeeId: string, dto: UpdateVendorEmployeeDto) {
    const vendor = await this.callerVendor(orgId, userId);
    const person = await this.people.findOne({ where: { id: employeeId, organizationId: orgId, vendorId: vendor.id, isDeleted: false } });
    if (!person) throw new NotFoundException('Person not found');
    if (dto.name !== undefined) person.name = dto.name.trim();
    if (dto.email !== undefined) person.email = dto.email?.toLowerCase() ?? null;
    if (dto.phone !== undefined) person.phone = dto.phone ?? null;
    if (dto.designation !== undefined) person.designation = dto.designation ?? null;
    if (dto.skills !== undefined) person.skills = dto.skills ?? [];
    if (dto.employmentType !== undefined) person.employmentType = dto.employmentType;
    if (dto.status !== undefined) person.status = dto.status;
    if (dto.notes !== undefined) person.notes = dto.notes ?? null;
    // rateAmount / rateCurrency / rateUnit are intentionally not editable here.
    return this.people.save(person);
  }

  async removePerson(orgId: string, userId: string, employeeId: string) {
    const vendor = await this.callerVendor(orgId, userId);
    const res = await this.people.update({ id: employeeId, organizationId: orgId, vendorId: vendor.id }, { isDeleted: true });
    if (!res.affected) throw new NotFoundException('Person not found');
    return { id: employeeId };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /** The vendorId a portal user belongs to (from their vendor-role membership). */
  async vendorIdForUser(orgId: string, userId: string): Promise<string | null> {
    const m = await this.memberships.findOne({ where: { organizationId: orgId, userId, role: 'vendor', status: 'active' } });
    return m?.vendorId ?? null;
  }

  /** The caller's own vendor, or 403. Every portal read starts here. */
  private async callerVendor(orgId: string, userId: string): Promise<VendorEntity> {
    const vendorId = await this.vendorIdForUser(orgId, userId);
    if (!vendorId) throw new ForbiddenException('No vendor portal access');
    const vendor = await this.vendors.findOne({ where: { id: vendorId, organizationId: orgId, isDeleted: false } });
    if (!vendor) throw new ForbiddenException('No vendor portal access');
    if (vendor.status === 'archived') throw new ForbiddenException('This vendor portal is not active');
    return vendor;
  }

  private async requireVendor(orgId: string, vendorId: string): Promise<VendorEntity> {
    const vendor = await this.vendors.findOne({ where: { id: vendorId, organizationId: orgId, isDeleted: false } });
    if (!vendor) throw new NotFoundException('Vendor not found');
    return vendor;
  }

  /** What the vendor sees of an agreement — no internal flags. */
  private agreementView(a: VendorAgreementEntity) {
    return {
      id: a.id,
      title: a.title,
      description: a.description,
      category: a.category,
      bodyHtml: a.bodyHtml,
      sourceFileId: a.sourceFileId,
      fields: a.fields ?? [],
      signedFileId: a.signedFileId,
      status: a.status,
      required: a.requiredForOnboarding,
      // A waived agreement is no longer asked of them — the portal stops
      // showing a Sign button for it.
      waived: !!a.waived,
      signature: a.signature,
      sentAt: a.sentAt,
      signedAt: a.signedAt,
      expiresAt: a.expiresAt,
    };
  }
}
