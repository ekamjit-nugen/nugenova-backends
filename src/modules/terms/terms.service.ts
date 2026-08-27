import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { PlatformTermsEntity } from './entities/platform-terms.entity';
import { TERMS_TEMPLATES, TermsTemplate } from './terms-templates';
import { StorageService } from '../../bootstrap/storage/storage.service';

/**
 * The synthetic organization id under which platform-level T&C PDFs are stored
 * in `document_files`. They belong to the platform, not any tenant, so they're
 * served through the terms/consent endpoints (any authenticated org member).
 */
export const PLATFORM_ORG_ID = '000000000000000000000000';

export interface TermsDoc {
  id: string;
  title: string | null;
  version: number;
  kind: 'html' | 'pdf';
  text: string | null;
  fileId: string | null;
  updatedAt: Date;
}

export interface TermsSummary {
  id: string;
  title: string | null;
  version: number;
  kind: 'html' | 'pdf';
  hasDocument: boolean;
  updatedAt: Date;
}

/** What the org's `consent` jsonb records about which T&C was accepted. */
export interface AcceptedTerms {
  termsId: string;
  version: number;
}

export interface CreateTermsInput {
  title: string;
  kind: 'html' | 'pdf';
  text?: string | null;
  fileId?: string | null;
}

/**
 * Owns the platform Terms & Conditions **library** — a catalog of named T&C
 * documents (HTML from a template/editor, or an uploaded PDF). The super admin
 * assigns one to each org at creation; the owner consents to it.
 *
 * A per-document `version` cache (id → version) is kept in memory so the
 * auth/guard hot paths can decide whether an org's accepted version is stale
 * without a DB round-trip. It's refreshed on every mutation.
 */
@Injectable()
export class TermsService implements OnModuleInit {
  private readonly logger = new Logger(TermsService.name);
  private versions = new Map<string, number>();

  constructor(
    @InjectRepository(PlatformTermsEntity)
    private readonly repo: Repository<PlatformTermsEntity>,
    private readonly storage: StorageService,
  ) {}

  async onModuleInit(): Promise<void> {
    // No default T&C is seeded — the library starts empty and the super admin
    // adds documents. Just warm the version cache.
    try {
      await this.refreshCache();
    } catch (err) {
      this.logger.warn(
        `Terms cache warm-up skipped: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private async refreshCache(): Promise<void> {
    const rows = await this.repo.find({ select: { id: true, version: true } });
    this.versions = new Map(rows.map((r) => [r.id, r.version]));
  }

  private toDoc(row: PlatformTermsEntity): TermsDoc {
    return {
      id: row.id,
      title: row.title ?? null,
      version: row.version,
      kind: row.kind === 'pdf' ? 'pdf' : 'html',
      text: row.text ?? null,
      fileId: row.fileId ?? null,
      updatedAt: row.updatedAt,
    };
  }

  private toSummary(row: PlatformTermsEntity): TermsSummary {
    return {
      id: row.id,
      title: row.title ?? null,
      version: row.version,
      kind: row.kind === 'pdf' ? 'pdf' : 'html',
      hasDocument: row.kind === 'pdf' && !!row.fileId,
      updatedAt: row.updatedAt,
    };
  }

  // ── Library CRUD ───────────────────────────────────────────────────────────

  /** The ready-made starting-point templates for authoring an HTML T&C. */
  listTemplates(): TermsTemplate[] {
    return TERMS_TEMPLATES;
  }

  /** All T&C documents in the library (newest first). */
  async list(): Promise<TermsSummary[]> {
    const rows = await this.repo.find({ order: { createdAt: 'DESC' } });
    return rows.map((r) => this.toSummary(r));
  }

  /** How many documents exist — used to prompt "add one" when empty. */
  async count(): Promise<number> {
    return this.repo.count();
  }

  async get(id: string): Promise<TermsDoc> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Terms & Conditions not found');
    return this.toDoc(row);
  }

  /** True iff a T&C document with this id exists. */
  async exists(id: string): Promise<boolean> {
    if (this.versions.has(id)) return true;
    return (await this.repo.count({ where: { id } })) > 0;
  }

  async create(input: CreateTermsInput, createdBy: string): Promise<TermsDoc> {
    this.validate(input);
    const saved = await this.repo.save(
      this.repo.create({
        title: input.title.trim(),
        version: 1,
        kind: input.kind,
        text: input.kind === 'html' ? (input.text ?? '').trim() : null,
        fileId: input.kind === 'pdf' ? (input.fileId ?? null) : null,
        updatedBy: createdBy,
      }),
    );
    this.versions.set(saved.id, saved.version);
    this.logger.log(`T&C '${saved.title}' (${saved.id}) created by ${createdBy}`);
    return this.toDoc(saved);
  }

  /** Edit a T&C — bumps its version, forcing its orgs to re-accept. */
  async update(
    id: string,
    input: CreateTermsInput,
    updatedBy: string,
  ): Promise<TermsDoc> {
    this.validate(input);
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Terms & Conditions not found');
    row.title = input.title.trim();
    row.kind = input.kind;
    row.text = input.kind === 'html' ? (input.text ?? '').trim() : null;
    row.fileId = input.kind === 'pdf' ? (input.fileId ?? row.fileId) : null;
    row.version = row.version + 1;
    row.updatedBy = updatedBy;
    const saved = await this.repo.save(row);
    this.versions.set(saved.id, saved.version);
    this.logger.log(
      `T&C '${saved.title}' (${saved.id}) edited → v${saved.version} by ${updatedBy}`,
    );
    return this.toDoc(saved);
  }

  /** Hard-delete a T&C. Caller MUST verify it isn't assigned to any org first. */
  async remove(id: string): Promise<void> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Terms & Conditions not found');
    await this.repo.delete({ id });
    this.versions.delete(id);
    this.logger.log(`T&C '${row.title}' (${id}) deleted`);
  }

  private validate(input: CreateTermsInput): void {
    if (!input.title || !input.title.trim()) {
      throw new BadRequestException('A name is required');
    }
    if (input.kind === 'html') {
      if (!input.text || input.text.trim().length < 10) {
        throw new BadRequestException('Terms text is too short');
      }
    } else if (input.kind === 'pdf') {
      if (!input.fileId) throw new BadRequestException('A PDF file is required');
    } else {
      throw new BadRequestException('kind must be "html" or "pdf"');
    }
  }

  // ── Consent helpers ────────────────────────────────────────────────────────

  /** Current version of a document (from cache), or null if it doesn't exist. */
  getVersion(id: string | null | undefined): number | null {
    if (!id) return null;
    return this.versions.get(id) ?? null;
  }

  /**
   * Whether an org must (re-)accept: it has an assigned T&C AND either never
   * consented, consented to a DIFFERENT document, or to an older version of it.
   * Sync (cache-backed) so guards/routing stay cheap.
   */
  needsConsent(
    termsId: string | null | undefined,
    consent: AcceptedTerms | null | undefined,
  ): boolean {
    if (!termsId) return false; // no T&C assigned → no gate
    const current = this.getVersion(termsId);
    if (current == null) return false; // assigned T&C missing → don't lock out
    if (!consent) return true;
    return consent.termsId !== termsId || consent.version < current;
  }

  /** The doc for the owner's consent screen (by the org's assigned termsId). */
  async getForConsent(termsId: string): Promise<TermsDoc> {
    return this.get(termsId);
  }

  /** Raw bytes of a T&C's PDF (by id), for the streaming endpoints. */
  async getDocumentBytes(termsId: string): Promise<{
    buffer: Buffer;
    mimeType: string;
    filename: string;
  }> {
    const doc = await this.get(termsId);
    if (doc.kind !== 'pdf' || !doc.fileId) {
      throw new NotFoundException('This terms document is not a PDF');
    }
    const file = await this.storage.getMeta(doc.fileId);
    const buffer = await this.storage.getBytes(file);
    return { buffer, mimeType: file.mimeType, filename: file.originalName };
  }
}
