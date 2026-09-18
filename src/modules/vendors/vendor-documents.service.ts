import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { VendorEntity } from './entities/vendor.entity';
import { VendorDocumentEntity, VendorDocumentSignature } from './entities/vendor-document.entity';
import { VendorsCaller } from './vendors.service';
import { CreateVendorDocumentDto, SignVendorDocumentDto, UpdateVendorDocumentDto } from './dto';

/**
 * Documents we share with a vendor — purchase orders, rate cards, policy packs.
 *
 * One-way: only we put documents here. A vendor has no upload (unlike a client),
 * so the vendor portal can read and sign but never send. Signing is opt-in per
 * document: `signatureRequired` is off unless an admin ticks it, and it never
 * touches onboarding clearance — that is what agreements are for.
 */
@Injectable()
export class VendorDocumentsService {
  constructor(
    @InjectRepository(VendorEntity) private readonly vendors: Repository<VendorEntity>,
    @InjectRepository(VendorDocumentEntity) private readonly documents: Repository<VendorDocumentEntity>,
  ) {}

  async list(orgId: string, vendorId: string) {
    await this.requireVendor(orgId, vendorId);
    const rows = await this.documents.find({ where: { organizationId: orgId, vendorId, isDeleted: false }, order: { createdAt: 'DESC' } });
    return rows.map((d) => this.view(d));
  }

  async share(caller: VendorsCaller, vendorId: string, dto: CreateVendorDocumentDto) {
    await this.requireVendor(caller.orgId, vendorId);
    const saved = await this.documents.save(this.documents.create({
      organizationId: caller.orgId,
      vendorId,
      fileId: dto.fileId,
      fileName: dto.fileName,
      mimeType: dto.mimeType ?? null,
      size: dto.size ?? null,
      title: dto.title?.trim() || null,
      description: dto.description?.trim() || null,
      signatureRequired: !!dto.signatureRequired,
      signature: null,
      signedAt: null,
      signedFileId: null,
      createdBy: caller.userId,
      isDeleted: false,
    }));
    return this.view(saved);
  }

  /** Turn the "vendor must sign this" tick on or off after sharing. */
  async update(orgId: string, vendorId: string, docId: string, dto: UpdateVendorDocumentDto) {
    const d = await this.require(orgId, vendorId, docId);
    if (dto.signatureRequired !== undefined) {
      if (d.signature) throw new BadRequestException('This document has already been signed');
      d.signatureRequired = dto.signatureRequired;
    }
    if (dto.title !== undefined) d.title = dto.title?.trim() || null;
    if (dto.description !== undefined) d.description = dto.description?.trim() || null;
    return this.view(await this.documents.save(d));
  }

  async remove(orgId: string, vendorId: string, docId: string) {
    const d = await this.require(orgId, vendorId, docId);
    d.isDeleted = true;
    await this.documents.save(d);
    return { id: docId };
  }

  // ── portal ─────────────────────────────────────────────────────────────────

  /** What the vendor sees: everything we shared with them. */
  async forVendor(orgId: string, vendorId: string) {
    const rows = await this.documents.find({ where: { organizationId: orgId, vendorId, isDeleted: false }, order: { createdAt: 'DESC' } });
    return rows.map((d) => this.view(d));
  }

  /** The vendor signs a document we asked them to sign. */
  async signAsVendor(orgId: string, vendorId: string, userId: string, docId: string, dto: SignVendorDocumentDto, ip?: string, ua?: string) {
    const d = await this.documents.findOne({ where: { id: docId, vendorId, organizationId: orgId, isDeleted: false } });
    if (!d) throw new NotFoundException('Document not found');
    if (!d.signatureRequired) throw new BadRequestException('This document does not need your signature');
    if (d.signature) throw new BadRequestException('This document has already been signed');
    if (!dto.signerName?.trim()) throw new BadRequestException('A signer name is required to sign');
    const now = new Date();
    const signature: VendorDocumentSignature = {
      signerName: dto.signerName.trim(),
      signerEmail: dto.signerEmail?.toLowerCase() ?? null,
      signedByUserId: userId,
      signedAt: now.toISOString(),
      ipAddress: ip ?? null,
      userAgent: ua ?? null,
      method: dto.method || 'typed',
    };
    d.signature = signature;
    d.signedAt = now;
    return this.view(await this.documents.save(d));
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async requireVendor(orgId: string, vendorId: string): Promise<VendorEntity> {
    const vendor = await this.vendors.findOne({ where: { id: vendorId, organizationId: orgId, isDeleted: false } });
    if (!vendor) throw new NotFoundException('Vendor not found');
    return vendor;
  }

  private async require(orgId: string, vendorId: string, docId: string): Promise<VendorDocumentEntity> {
    const d = await this.documents.findOne({ where: { id: docId, vendorId, organizationId: orgId, isDeleted: false } });
    if (!d) throw new NotFoundException('Document not found');
    return d;
  }

  private view(d: VendorDocumentEntity) {
    return {
      id: d.id,
      vendorId: d.vendorId,
      fileId: d.fileId,
      name: d.title || d.fileName,
      fileName: d.fileName,
      mimeType: d.mimeType,
      size: d.size != null ? Number(d.size) : null,
      description: d.description,
      signatureRequired: !!d.signatureRequired,
      signature: d.signature,
      signedAt: d.signedAt,
      signedFileId: d.signedFileId,
      createdAt: d.createdAt,
      /** Derived, so it can never go stale. */
      status: d.signature ? 'signed' : d.signatureRequired ? 'awaiting_vendor' : 'shared',
    };
  }
}
