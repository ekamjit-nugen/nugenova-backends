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
import { DEFAULT_TERMS_HTML } from './default-terms';
import { TERMS_TEMPLATES, TermsTemplate } from './terms-templates';
import { StorageService } from '../../bootstrap/storage/storage.service';

/**
 * The synthetic organization id under which platform-level T&C PDFs are stored
 * in `document_files`. They belong to the platform, not any tenant, so they're
 * served through the terms/consent endpoints (any authenticated org member) — not
 * the org-scoped `/media` access check.
 */
export const PLATFORM_ORG_ID = '000000000000000000000000';

export interface CurrentTerms {
  version: number;
  kind: 'html' | 'pdf';
  /** HTML body for the `html` kind; null for `pdf`. */
  text: string | null;
  title: string | null;
  /** `document_files` id for the `pdf` kind; null for `html`. */
  fileId: string | null;
  updatedAt: Date;
}

/**
 * Owns the global platform Terms & Conditions. Seeds v1 on first boot; each
 * `publish` appends a new version (HTML from a template/editor, or an uploaded
 * PDF). The current version is cached in memory (single pm2 fork) so the
 * auth/guard hot paths can compare an org's accepted version without a DB
 * round-trip on every request.
 */
@Injectable()
export class TermsService implements OnModuleInit {
  private readonly logger = new Logger(TermsService.name);
  private current: CurrentTerms | null = null;

  constructor(
    @InjectRepository(PlatformTermsEntity)
    private readonly repo: Repository<PlatformTermsEntity>,
    private readonly storage: StorageService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.refresh();
      if (!this.current) {
        const seeded = await this.repo.save(
          this.repo.create({
            version: 1,
            kind: 'html',
            text: DEFAULT_TERMS_HTML,
            title: 'Standard SaaS',
            fileId: null,
            updatedBy: null,
          }),
        );
        this.current = this.toCurrent(seeded);
        this.logger.log('Seeded default Terms & Conditions (v1)');
      }
    } catch (err) {
      this.logger.warn(
        `Terms seeding skipped: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private toCurrent(row: PlatformTermsEntity): CurrentTerms {
    return {
      version: row.version,
      kind: row.kind === 'pdf' ? 'pdf' : 'html',
      text: row.text ?? null,
      title: row.title ?? null,
      fileId: row.fileId ?? null,
      updatedAt: row.updatedAt,
    };
  }

  private async refresh(): Promise<void> {
    const row = await this.repo.findOne({
      where: {},
      order: { version: 'DESC' },
    });
    this.current = row ? this.toCurrent(row) : null;
  }

  /** The ready-made templates offered as starting points in the editor. */
  listTemplates(): TermsTemplate[] {
    return TERMS_TEMPLATES;
  }

  /** Current terms (cached). Falls back to a DB read if the cache is cold. */
  async getCurrent(): Promise<CurrentTerms> {
    if (!this.current) await this.refresh();
    // If still null (never seeded), synthesize v1 in-memory so callers get text.
    return (
      this.current || {
        version: 1,
        kind: 'html',
        text: DEFAULT_TERMS_HTML,
        title: 'Standard SaaS',
        fileId: null,
        updatedAt: new Date(0),
      }
    );
  }

  /** Current version only — the hot-path comparison for the consent gate. */
  getCurrentVersion(): number {
    return this.current?.version ?? 1;
  }

  private async nextVersion(): Promise<number> {
    if (!this.current) await this.refresh();
    return (this.current?.version ?? 0) + 1;
  }

  /** Append a new HTML terms version; forces every org to re-accept. */
  async publishHtml(
    text: string,
    title: string | null,
    updatedBy: string,
  ): Promise<CurrentTerms> {
    const body = (text ?? '').trim();
    if (body.length < 10) {
      throw new BadRequestException('Terms text is too short');
    }
    const saved = await this.repo.save(
      this.repo.create({
        version: await this.nextVersion(),
        kind: 'html',
        text: body,
        title: title?.trim() || null,
        fileId: null,
        updatedBy,
      }),
    );
    this.current = this.toCurrent(saved);
    this.logger.log(
      `Terms & Conditions updated to v${saved.version} (html) by ${updatedBy}`,
    );
    return this.current;
  }

  /** Append a new PDF terms version; the org reads the PDF and accepts it. */
  async publishPdf(
    fileId: string,
    title: string | null,
    updatedBy: string,
  ): Promise<CurrentTerms> {
    if (!fileId) throw new BadRequestException('A PDF file is required');
    const saved = await this.repo.save(
      this.repo.create({
        version: await this.nextVersion(),
        kind: 'pdf',
        text: null,
        title: title?.trim() || null,
        fileId,
        updatedBy,
      }),
    );
    this.current = this.toCurrent(saved);
    this.logger.log(
      `Terms & Conditions updated to v${saved.version} (pdf ${fileId}) by ${updatedBy}`,
    );
    return this.current;
  }

  /**
   * Backward-compatible HTML publish used by `PUT /admin/terms` and the tests.
   * @deprecated prefer `publishHtml`.
   */
  async update(text: string, updatedBy: string): Promise<CurrentTerms> {
    return this.publishHtml(text, null, updatedBy);
  }

  /** Raw bytes of the current terms PDF, for the streaming endpoints. */
  async getDocumentBytes(): Promise<{
    buffer: Buffer;
    mimeType: string;
    filename: string;
  }> {
    const cur = await this.getCurrent();
    if (cur.kind !== 'pdf' || !cur.fileId) {
      throw new NotFoundException('The current terms are not a PDF document');
    }
    const file = await this.storage.getMeta(cur.fileId);
    const buffer = await this.storage.getBytes(file);
    return { buffer, mimeType: file.mimeType, filename: file.originalName };
  }
}
