import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { PlatformTermsEntity } from './entities/platform-terms.entity';
import { DEFAULT_TERMS_HTML } from './default-terms';

export interface CurrentTerms {
  version: number;
  text: string;
  updatedAt: Date;
}

/**
 * Owns the global platform Terms & Conditions. Seeds v1 on first boot; each
 * `update` appends a new version. The current version is cached in memory (single
 * pm2 fork) so the auth/guard hot paths can compare an org's accepted version
 * without a DB round-trip on every request.
 */
@Injectable()
export class TermsService implements OnModuleInit {
  private readonly logger = new Logger(TermsService.name);
  private current: CurrentTerms | null = null;

  constructor(
    @InjectRepository(PlatformTermsEntity)
    private readonly repo: Repository<PlatformTermsEntity>,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.refresh();
      if (!this.current) {
        const seeded = await this.repo.save(
          this.repo.create({ version: 1, text: DEFAULT_TERMS_HTML, updatedBy: null }),
        );
        this.current = {
          version: seeded.version,
          text: seeded.text,
          updatedAt: seeded.updatedAt,
        };
        this.logger.log('Seeded default Terms & Conditions (v1)');
      }
    } catch (err) {
      this.logger.warn(
        `Terms seeding skipped: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private async refresh(): Promise<void> {
    const row = await this.repo.findOne({
      where: {},
      order: { version: 'DESC' },
    });
    this.current = row
      ? { version: row.version, text: row.text, updatedAt: row.updatedAt }
      : null;
  }

  /** Current terms (cached). Falls back to a DB read if the cache is cold. */
  async getCurrent(): Promise<CurrentTerms> {
    if (!this.current) await this.refresh();
    // If still null (never seeded), synthesize v1 in-memory so callers get text.
    return (
      this.current || {
        version: 1,
        text: DEFAULT_TERMS_HTML,
        updatedAt: new Date(0),
      }
    );
  }

  /** Current version only — the hot-path comparison for the consent gate. */
  getCurrentVersion(): number {
    return this.current?.version ?? 1;
  }

  /** Append a new terms version; forces every org to re-accept. */
  async update(text: string, updatedBy: string): Promise<CurrentTerms> {
    const nextVersion = (this.current?.version ?? 0) + 1;
    const saved = await this.repo.save(
      this.repo.create({ version: nextVersion, text, updatedBy }),
    );
    this.current = {
      version: saved.version,
      text: saved.text,
      updatedAt: saved.updatedAt,
    };
    this.logger.log(`Terms & Conditions updated to v${saved.version} by ${updatedBy}`);
    return this.current;
  }
}
