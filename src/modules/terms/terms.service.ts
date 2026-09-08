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
  isActive: boolean;
  updatedAt: Date;
}

export interface TermsSummary {
  id: string;
  title: string | null;
  version: number;
  kind: 'html' | 'pdf';
  hasDocument: boolean;
  isActive: boolean;
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
 * Owns the platform Terms & Conditions. Exactly ONE document is `active` at a
 * time, and EVERY organization — active or not — must accept the active document
 * at its current version before the app opens. Creating a new T&C publishes it as
 * the active one; editing the active doc bumps its version. Either makes every
 * org's consent stale, re-gating them at login (`needsConsentActive`). Older docs
 * are kept for audit but gate nobody.
 *
 * A per-document `version` cache (id → version) plus the active `{id, version}`
 * are kept in memory so the auth/guard hot paths can decide whether an org's
 * accepted version is stale without a DB round-trip. Refreshed on every mutation.
 */
@Injectable()
export class TermsService implements OnModuleInit {
  private readonly logger = new Logger(TermsService.name);
  private versions = new Map<string, number>();
  /** The single active document (id + current version), cached for the gate. */
  private active: { id: string; version: number } | null = null;

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
    const rows = await this.repo.find({
      select: { id: true, version: true, isActive: true },
    });
    this.versions = new Map(rows.map((r) => [r.id, r.version]));
    const activeRow = rows.find((r) => r.isActive);
    this.active = activeRow
      ? { id: activeRow.id, version: activeRow.version }
      : null;
  }

  private toDoc(row: PlatformTermsEntity): TermsDoc {
    return {
      id: row.id,
      title: row.title ?? null,
      version: row.version,
      kind: row.kind === 'pdf' ? 'pdf' : 'html',
      text: row.text ?? null,
      fileId: row.fileId ?? null,
      isActive: !!row.isActive,
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
      isActive: !!row.isActive,
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

  /**
   * Create a new T&C and PUBLISH it as the single active document — every org
   * must accept it before the app opens. Deactivates any previously-active doc
   * (which is kept for audit). Pass `activate: false` to add it to the library
   * without publishing.
   */
  async create(
    input: CreateTermsInput,
    createdBy: string,
    activate = true,
  ): Promise<TermsDoc> {
    this.validate(input);
    const saved = await this.repo.save(
      this.repo.create({
        title: input.title.trim(),
        version: 1,
        kind: input.kind,
        text: input.kind === 'html' ? (input.text ?? '').trim() : null,
        fileId: input.kind === 'pdf' ? (input.fileId ?? null) : null,
        isActive: false,
        updatedBy: createdBy,
      }),
    );
    this.versions.set(saved.id, saved.version);
    this.logger.log(`T&C '${saved.title}' (${saved.id}) created by ${createdBy}`);
    if (activate) return this.activate(saved.id);
    await this.refreshCache();
    return this.toDoc(saved);
  }

  /**
   * Make one document THE active platform T&C (and deactivate all others in a
   * single transaction so the partial unique index is never violated). Every
   * org's consent goes stale and they re-gate at login.
   */
  async activate(id: string): Promise<TermsDoc> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Terms & Conditions not found');
    await this.repo.manager.transaction(async (tx) => {
      await tx.update(PlatformTermsEntity, { isActive: true }, { isActive: false });
      await tx.update(PlatformTermsEntity, { id }, { isActive: true });
    });
    await this.refreshCache();
    this.logger.log(`T&C '${row.title}' (${id}) is now the active platform terms`);
    return this.get(id);
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
    if (saved.isActive) this.active = { id: saved.id, version: saved.version };
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
    if (this.active?.id === id) this.active = null;
    this.logger.log(`T&C '${row.title}' (${id}) deleted`);
  }

  /** Whether a document is the active platform T&C. */
  isActiveTerms(id: string): boolean {
    return this.active?.id === id;
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

  /** The active platform T&C's `{id, version}`, or null if none is configured. */
  getActive(): { id: string; version: number } | null {
    return this.active;
  }

  /**
   * Whether an org must (re-)accept the ACTIVE platform T&C — the single gate
   * every org passes through, regardless of which document (if any) it once
   * accepted. True iff an active T&C exists AND the org either never consented,
   * consented to a DIFFERENT document, or to an older version of the active one.
   * Sync (cache-backed) so the login-routing/guard hot paths stay cheap. When no
   * T&C is configured at all, returns false so nobody is locked out.
   */
  needsConsentActive(consent: AcceptedTerms | null | undefined): boolean {
    if (!this.active) return false;
    if (!consent) return true;
    return (
      consent.termsId !== this.active.id || consent.version < this.active.version
    );
  }

  /** The active T&C document for the owner's consent screen (or null if none). */
  async getActiveForConsent(): Promise<TermsDoc | null> {
    if (!this.active) return null;
    return this.get(this.active.id);
  }

  /** The doc for the owner's consent screen (by the org's assigned termsId). */
  async getForConsent(termsId: string): Promise<TermsDoc> {
    return this.get(termsId);
  }

  /**
   * A T&C document's bytes for the super-admin preview endpoint — for BOTH kinds:
   *   - `pdf`  → the stored PDF bytes.
   *   - `html` → the document's HTML wrapped in a minimal readable page, served as
   *     `text/html` so the browser renders it in a new tab (opening the actual
   *     terms, not a download). Previously this threw for html docs, so clicking
   *     an HTML T&C opened nothing.
   */
  async getDocumentBytes(termsId: string): Promise<{
    buffer: Buffer;
    mimeType: string;
    filename: string;
  }> {
    const doc = await this.get(termsId);

    if (doc.kind === 'pdf') {
      if (!doc.fileId) {
        throw new NotFoundException('This terms document has no PDF file');
      }
      const file = await this.storage.getMeta(doc.fileId);
      const buffer = await this.storage.getBytes(file);
      return { buffer, mimeType: file.mimeType, filename: file.originalName };
    }

    // html kind — render the stored HTML as a standalone, readable page.
    const title = doc.title || 'Terms & Conditions';
    const safeTitle = title.replace(
      /[&<>"']/g,
      (ch) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string,
    );
    const page =
      `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>${safeTitle} · v${doc.version}</title>` +
      `<style>` +
      `body{margin:0;background:#f1f5f9;color:#0f172a;` +
      `font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}` +
      `.wrap{max-width:820px;margin:0 auto;padding:40px 24px}` +
      `.card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:40px 44px;` +
      `box-shadow:0 1px 3px rgba(15,23,42,.06)}` +
      `h1{font-size:24px;margin:0 0 4px}.meta{color:#64748b;font-size:13px;margin:0 0 24px}` +
      `.doc h1,.doc h2,.doc h3{line-height:1.3}.doc img{max-width:100%}` +
      `.doc table{border-collapse:collapse}.doc td,.doc th{border:1px solid #e2e8f0;padding:6px 10px}` +
      `</style></head><body><div class="wrap"><div class="card">` +
      `<h1>${safeTitle}</h1><p class="meta">Version ${doc.version}</p>` +
      `<div class="doc">${doc.text ?? ''}</div>` +
      `</div></div></body></html>`;

    return {
      buffer: Buffer.from(page, 'utf-8'),
      mimeType: 'text/html; charset=utf-8',
      filename: `${(title || 'terms').replace(/[^\w.\-]+/g, '_')}.html`,
    };
  }
}
