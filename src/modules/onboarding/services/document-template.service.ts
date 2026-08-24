import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { OnboardingDocumentTemplateEntity } from '../entities/onboarding-document-template.entity';
import { BUILTIN_TEMPLATES } from '../builtin-templates';
import { CreateTemplateDto } from '../dto';

/**
 * Owns the onboarding document-template library: seeds the built-ins once at
 * startup (idempotent, keyed by `key`) and lets super admins add/remove custom
 * templates.
 */
@Injectable()
export class DocumentTemplateService implements OnModuleInit {
  private readonly logger = new Logger(DocumentTemplateService.name);

  constructor(
    @InjectRepository(OnboardingDocumentTemplateEntity)
    private readonly repo: Repository<OnboardingDocumentTemplateEntity>,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.seedBuiltins();
    } catch (err) {
      // Never block boot on seeding (e.g. table not migrated yet in some envs).
      this.logger.warn(
        `Built-in template seeding skipped: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  /** Upsert every built-in by its stable `key`. Safe to run on every boot. */
  async seedBuiltins(): Promise<void> {
    const liveKeys = new Set(BUILTIN_TEMPLATES.map((t) => t.key));
    // Retire built-ins that are no longer in the library (e.g. the old bodyHtml
    // agreement templates now that agreements are admin-uploaded PDFs).
    const existingBuiltins = await this.repo.find({
      where: { isBuiltin: true, isDeleted: false },
    });
    for (const row of existingBuiltins) {
      if (row.key && !liveKeys.has(row.key)) {
        row.isDeleted = true;
        await this.repo.save(row);
      }
    }
    for (const t of BUILTIN_TEMPLATES) {
      const existing = await this.repo.findOne({ where: { key: t.key } });
      if (existing) {
        existing.name = t.name;
        existing.description = t.description;
        existing.category = t.category;
        existing.bodyHtml = t.bodyHtml;
        existing.requiresSignature = t.requiresSignature;
        existing.requiresUpload = t.requiresUpload;
        existing.fields = t.fields;
        existing.isBuiltin = true;
        existing.isDeleted = false;
        await this.repo.save(existing);
      } else {
        await this.repo.save(
          this.repo.create({
            key: t.key,
            name: t.name,
            description: t.description,
            category: t.category,
            bodyHtml: t.bodyHtml,
            requiresSignature: t.requiresSignature,
            requiresUpload: t.requiresUpload,
            fields: t.fields,
            isBuiltin: true,
            organizationId: null,
            isDeleted: false,
          }),
        );
      }
    }
    this.logger.log(`Seeded ${BUILTIN_TEMPLATES.length} built-in templates`);
  }

  toPublic(t: OnboardingDocumentTemplateEntity) {
    return {
      id: t.id,
      key: t.key,
      name: t.name,
      description: t.description,
      category: t.category,
      bodyHtml: t.bodyHtml,
      requiresSignature: t.requiresSignature,
      requiresUpload: t.requiresUpload,
      fields: t.fields || [],
      isBuiltin: t.isBuiltin,
    };
  }

  async list() {
    const rows = await this.repo.find({
      where: { isDeleted: false, organizationId: IsNull() },
      order: { isBuiltin: 'DESC', name: 'ASC' },
    });
    return rows.map((t) => this.toPublic(t));
  }

  async create(dto: CreateTemplateDto, createdBy: string) {
    const saved = await this.repo.save(
      this.repo.create({
        key: null,
        name: dto.name.trim(),
        description: dto.description ?? null,
        category: dto.category || 'other',
        bodyHtml: dto.bodyHtml ?? null,
        requiresSignature: dto.requiresSignature ?? false,
        requiresUpload: dto.requiresUpload ?? false,
        fields: (dto.fields as any) ?? null,
        isBuiltin: false,
        organizationId: null,
        createdBy,
        isDeleted: false,
      }),
    );
    return this.toPublic(saved);
  }

  async remove(id: string): Promise<void> {
    const t = await this.repo.findOne({ where: { id } });
    if (!t) throw new NotFoundException('Template not found');
    if (t.isBuiltin) {
      // Built-ins can't be deleted, only hidden by not requesting them.
      throw new NotFoundException('Built-in templates cannot be deleted');
    }
    t.isDeleted = true;
    await this.repo.save(t);
  }

  /** Resolve built-in/custom templates by their `key`, skipping unknowns. */
  async resolveByKeys(keys: string[]) {
    if (!keys.length) return [];
    const found: OnboardingDocumentTemplateEntity[] = [];
    for (const key of keys) {
      const t = await this.repo.findOne({
        where: { key, isDeleted: false },
      });
      if (t) found.push(t);
    }
    return found;
  }
}
