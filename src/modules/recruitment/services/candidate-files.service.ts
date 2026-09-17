import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';

import { StorageService } from '../../../bootstrap/storage/storage.service';
import { DocumentFileEntity } from '../../../bootstrap/storage/document-file.entity';
import { CandidateEntity } from '../entities';
import { normalizeEmail, normalizePhone } from '../recruitment.utils';

export interface DuplicateMatch {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  currentCompany: string | null;
  status: string;
  updatedAt: Date;
  matchedOn: ('email' | 'phone' | 'name')[];
}

/** Largest Word file rendered for the in-portal preview. */
const MAX_PREVIEW_BYTES = 15 * 1024 * 1024;

export const isWordDocument = (file: Pick<DocumentFileEntity, 'originalName' | 'mimeType'>) =>
  /\.docx$/i.test(file.originalName || '') || (file.mimeType || '').toLowerCase().includes('wordprocessingml');

/**
 * Candidate files (CVs, offer letters). Files are stored and shown as they are —
 * nothing is read out of a CV into the profile and no AI is involved. The only
 * transformation is rendering a Word CV as HTML so it can be viewed in the portal.
 */
@Injectable()
export class CandidateFilesService {
  private readonly logger = new Logger(CandidateFilesService.name);

  constructor(
    private readonly storage: StorageService,
    @InjectRepository(CandidateEntity) private readonly candidates: Repository<CandidateEntity>,
  ) {}

  /** Load a file's metadata, scoped to the caller's org (404 otherwise). */
  async requireOrgFile(orgId: string, fileId: string): Promise<DocumentFileEntity> {
    const meta = await this.storage.getMeta(fileId).catch(() => null);
    if (!meta || meta.organizationId !== orgId) throw new NotFoundException('File not found');
    return meta;
  }

  bytes(file: DocumentFileEntity): Promise<Buffer> {
    return this.storage.getBytes(file);
  }

  /**
   * A Word CV as HTML for the in-portal viewer. The browser renders it in a
   * sandboxed frame (no scripts), so embedded links or markup can't run.
   */
  async previewHtml(file: DocumentFileEntity): Promise<string> {
    if (!isWordDocument(file)) throw new BadRequestException('Only Word (.docx) files need a converted preview');
    if (file.size != null && Number(file.size) > MAX_PREVIEW_BYTES) throw new BadRequestException('This file is too large to preview — download it instead');
    try {
      const buffer = await this.storage.getBytes(file);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mammoth = require('mammoth') as { convertToHtml(i: { buffer: Buffer }): Promise<{ value: string }> };
      const { value } = await mammoth.convertToHtml({ buffer });
      return value || '';
    } catch (err) {
      this.logger.warn(`docx preview failed for ${file.id}: ${(err as Error).message}`);
      throw new BadRequestException('This Word file could not be previewed — download it instead');
    }
  }

  /** Candidates matching an email, phone (normalised) or exact name. */
  async findDuplicates(
    orgId: string,
    probe: { email?: string | null; phone?: string | null; name?: string | null; excludeId?: string },
  ): Promise<DuplicateMatch[]> {
    const email = normalizeEmail(probe.email);
    const phone = normalizePhone(probe.phone);
    const name = probe.name?.trim().toLowerCase() || null;
    if (!email && !phone && !name) return [];
    const qb = this.candidates.createQueryBuilder('c')
      .where('c.organization_id = :orgId AND c.is_deleted = false', { orgId })
      .andWhere(new Brackets((b) => {
        if (email) b.orWhere('c.email_norm = :email', { email });
        if (phone) b.orWhere('c.phone_norm = :phone', { phone });
        if (name) b.orWhere('lower(c.full_name) = :name', { name });
      }));
    if (probe.excludeId) qb.andWhere('c.id <> :excludeId', { excludeId: probe.excludeId });
    const rows = await qb.orderBy('c.updated_at', 'DESC').take(10).getMany();
    return rows.map((c) => ({
      id: c.id, fullName: c.fullName, email: c.email, phone: c.phone, currentCompany: c.currentCompany, status: c.status, updatedAt: c.updatedAt,
      matchedOn: [
        ...(email && c.emailNorm === email ? ['email' as const] : []),
        ...(phone && c.phoneNorm === phone ? ['phone' as const] : []),
        ...(name && c.fullName.toLowerCase() === name ? ['name' as const] : []),
      ],
    }));
  }
}
