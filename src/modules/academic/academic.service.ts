import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { AcademicYearEntity } from './entities/academic-year.entity';
import { TermEntity } from './entities/term.entity';
import {
  CreateAcademicYearDto,
  CreateTermDto,
  UpdateAcademicYearDto,
  UpdateTermDto,
} from './dto';

export interface AcademicYearView {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  isCurrent: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface TermView {
  id: string;
  academicYearId: string;
  name: string;
  startDate: string;
  endDate: string;
  sequence: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * AcademicService — the tenant-scoped academic calendar (years + ordered terms)
 * the future gradebook anchors to. Invariants enforced here (and backed by
 * partial-unique / unique indexes so a race can't break them):
 *
 *  - EXACTLY ONE academic year per org may be `isCurrent`. Creating/updating a
 *    year with `isCurrent` clears the flag on every other year in the org first,
 *    all in one transaction.
 *  - Terms are ORDERED by `sequence`, unique within a year. Every date range is
 *    validated (start < end) and terms must fall within their year's bounds.
 *
 * Every method takes `orgId` from the JWT (never the client) and filters on it,
 * so one org can never read or mutate another's calendar.
 */
@Injectable()
export class AcademicService {
  private readonly logger = new Logger(AcademicService.name);

  constructor(
    @InjectRepository(AcademicYearEntity)
    private readonly years: Repository<AcademicYearEntity>,
    @InjectRepository(TermEntity)
    private readonly terms: Repository<TermEntity>,
  ) {}

  // ── academic years ──────────────────────────────────────────────────────────

  async createYear(
    orgId: string,
    dto: CreateAcademicYearDto,
    actorId: string,
  ): Promise<AcademicYearView> {
    this.assertDateOrder(dto.startDate, dto.endDate);
    const row = this.years.create({
      organizationId: orgId,
      name: dto.name.trim(),
      startDate: dto.startDate,
      endDate: dto.endDate,
      isCurrent: false,
      createdBy: actorId,
      updatedBy: actorId,
    });

    const saved = await this.years.manager.transaction(async (tx) => {
      const persisted = await tx.save(AcademicYearEntity, row);
      if (dto.isCurrent) {
        await this.markCurrentInTx(tx, orgId, persisted.id);
        persisted.isCurrent = true;
      }
      return persisted;
    });
    this.logger.log(
      `Academic year '${saved.name}' (${saved.id}) created for org ${orgId}`,
    );
    return this.toYearView(saved);
  }

  async listYears(orgId: string): Promise<AcademicYearView[]> {
    const rows = await this.years.find({
      where: { organizationId: orgId },
      order: { startDate: 'DESC' },
    });
    return rows.map((r) => this.toYearView(r));
  }

  async getYear(orgId: string, id: string): Promise<AcademicYearView> {
    return this.toYearView(await this.requireYear(orgId, id));
  }

  /** The org's single current academic year, or null if none is set yet. */
  async getCurrentYear(orgId: string): Promise<AcademicYearView | null> {
    const row = await this.years.findOne({
      where: { organizationId: orgId, isCurrent: true },
    });
    return row ? this.toYearView(row) : null;
  }

  async updateYear(
    orgId: string,
    id: string,
    dto: UpdateAcademicYearDto,
    actorId: string,
  ): Promise<AcademicYearView> {
    const row = await this.requireYear(orgId, id);
    const start = dto.startDate ?? row.startDate;
    const end = dto.endDate ?? row.endDate;
    this.assertDateOrder(start, end);

    if (dto.name !== undefined) row.name = dto.name.trim();
    row.startDate = start;
    row.endDate = end;
    row.updatedBy = actorId;

    const saved = await this.years.manager.transaction(async (tx) => {
      // `isCurrent` can only be turned ON here (making this THE current year);
      // demoting the sole current year is done by promoting another one.
      if (dto.isCurrent === true) {
        await this.markCurrentInTx(tx, orgId, row.id);
        row.isCurrent = true;
      }
      return tx.save(AcademicYearEntity, row);
    });
    return this.toYearView(saved);
  }

  /** Make one year THE current year (clears the flag on all others). */
  async setCurrentYear(
    orgId: string,
    id: string,
    actorId: string,
  ): Promise<AcademicYearView> {
    const row = await this.requireYear(orgId, id);
    await this.years.manager.transaction(async (tx) => {
      await this.markCurrentInTx(tx, orgId, row.id);
      await tx.update(AcademicYearEntity, { id: row.id }, { updatedBy: actorId });
    });
    return this.getYear(orgId, id);
  }

  /** Delete a year AND its terms (a calendar with no marks yet — cascade is safe). */
  async removeYear(orgId: string, id: string): Promise<void> {
    const row = await this.requireYear(orgId, id);
    await this.years.manager.transaction(async (tx) => {
      await tx.delete(TermEntity, { organizationId: orgId, academicYearId: row.id });
      await tx.delete(AcademicYearEntity, { id: row.id, organizationId: orgId });
    });
    this.logger.log(`Academic year '${row.name}' (${id}) deleted for org ${orgId}`);
  }

  // ── terms ───────────────────────────────────────────────────────────────────

  async createTerm(
    orgId: string,
    yearId: string,
    dto: CreateTermDto,
    actorId: string,
  ): Promise<TermView> {
    const year = await this.requireYear(orgId, yearId);
    this.assertDateOrder(dto.startDate, dto.endDate);
    this.assertWithinYear(year, dto.startDate, dto.endDate);

    const existing = await this.terms.find({
      where: { organizationId: orgId, academicYearId: yearId },
    });
    const sequence = await this.resolveSequence(existing, dto.sequence);

    const saved = await this.terms.save(
      this.terms.create({
        academicYearId: yearId,
        organizationId: orgId,
        name: dto.name.trim(),
        startDate: dto.startDate,
        endDate: dto.endDate,
        sequence,
        createdBy: actorId,
        updatedBy: actorId,
      }),
    );
    this.logger.log(
      `Term '${saved.name}' (${saved.id}) #${sequence} created under year ${yearId}`,
    );
    return this.toTermView(saved);
  }

  async listTerms(orgId: string, yearId: string): Promise<TermView[]> {
    await this.requireYear(orgId, yearId);
    const rows = await this.terms.find({
      where: { organizationId: orgId, academicYearId: yearId },
      order: { sequence: 'ASC' },
    });
    return rows.map((r) => this.toTermView(r));
  }

  async updateTerm(
    orgId: string,
    yearId: string,
    termId: string,
    dto: UpdateTermDto,
    actorId: string,
  ): Promise<TermView> {
    const year = await this.requireYear(orgId, yearId);
    const row = await this.requireTerm(orgId, yearId, termId);
    const start = dto.startDate ?? row.startDate;
    const end = dto.endDate ?? row.endDate;
    this.assertDateOrder(start, end);
    this.assertWithinYear(year, start, end);

    if (dto.sequence !== undefined && dto.sequence !== row.sequence) {
      const clash = await this.terms.findOne({
        where: {
          organizationId: orgId,
          academicYearId: yearId,
          sequence: dto.sequence,
        },
      });
      if (clash && clash.id !== row.id) {
        throw new BadRequestException(
          `Another term already uses sequence ${dto.sequence}`,
        );
      }
      row.sequence = dto.sequence;
    }
    if (dto.name !== undefined) row.name = dto.name.trim();
    row.startDate = start;
    row.endDate = end;
    row.updatedBy = actorId;

    return this.toTermView(await this.terms.save(row));
  }

  async removeTerm(
    orgId: string,
    yearId: string,
    termId: string,
  ): Promise<void> {
    const row = await this.requireTerm(orgId, yearId, termId);
    await this.terms.delete({ id: row.id, organizationId: orgId });
    this.logger.log(`Term '${row.name}' (${termId}) deleted from year ${yearId}`);
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  private async requireYear(
    orgId: string,
    id: string,
  ): Promise<AcademicYearEntity> {
    const row = await this.years.findOne({
      where: { id, organizationId: orgId },
    });
    if (!row) throw new NotFoundException('Academic year not found');
    return row;
  }

  private async requireTerm(
    orgId: string,
    yearId: string,
    termId: string,
  ): Promise<TermEntity> {
    const row = await this.terms.findOne({
      where: { id: termId, academicYearId: yearId, organizationId: orgId },
    });
    if (!row) throw new NotFoundException('Term not found');
    return row;
  }

  /** Clear `isCurrent` on every year in the org except `keepId`. */
  private async markCurrentInTx(
    tx: EntityManager,
    orgId: string,
    keepId: string,
  ): Promise<void> {
    await tx.update(
      AcademicYearEntity,
      { organizationId: orgId, isCurrent: true },
      { isCurrent: false },
    );
    await tx.update(AcademicYearEntity, { id: keepId }, { isCurrent: true });
  }

  /** Next free sequence (append) when unspecified; otherwise ensure it's unused. */
  private async resolveSequence(
    existing: TermEntity[],
    requested?: number,
  ): Promise<number> {
    if (requested === undefined) {
      const max = existing.reduce((m, t) => Math.max(m, t.sequence), 0);
      return max + 1;
    }
    if (existing.some((t) => t.sequence === requested)) {
      throw new BadRequestException(
        `Another term already uses sequence ${requested}`,
      );
    }
    return requested;
  }

  private assertDateOrder(startDate: string, endDate: string): void {
    if (startDate >= endDate) {
      throw new BadRequestException('startDate must be before endDate');
    }
  }

  private assertWithinYear(
    year: AcademicYearEntity,
    startDate: string,
    endDate: string,
  ): void {
    if (startDate < year.startDate || endDate > year.endDate) {
      throw new BadRequestException(
        'Term dates must fall within the academic year',
      );
    }
  }

  private toYearView(row: AcademicYearEntity): AcademicYearView {
    return {
      id: row.id,
      name: row.name,
      startDate: row.startDate,
      endDate: row.endDate,
      isCurrent: !!row.isCurrent,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toTermView(row: TermEntity): TermView {
    return {
      id: row.id,
      academicYearId: row.academicYearId,
      name: row.name,
      startDate: row.startDate,
      endDate: row.endDate,
      sequence: row.sequence,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
