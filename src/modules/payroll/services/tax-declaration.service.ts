import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { TaxDeclarationEntity, TaxProof } from '../entities/tax-declaration.entity';
import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';
import { UserEntity } from '../../auth/entities/user.entity';
import { NotifierService } from '../../notification/notifier.service';
import { StorageService } from '../../../bootstrap/storage/storage.service';
import { SaveTaxDeclarationDto, ReviewTaxDeclarationDto } from '../dto';

/** Per-section annual caps for the old regime (mirrors payroll.oldRegimeExemptions). */
const CAP_80C = 150000;
const CAP_24B = 200000; // home-loan interest, §24(b)

@Injectable()
export class TaxDeclarationService {
  private readonly logger = new Logger(TaxDeclarationService.name);

  constructor(
    @InjectRepository(TaxDeclarationEntity)
    private readonly declarations: Repository<TaxDeclarationEntity>,
    @InjectRepository(OrgMembershipEntity)
    private readonly memberships: Repository<OrgMembershipEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    private readonly notifier: NotifierService,
    private readonly storage: StorageService,
  ) {}

  /** FY start year (the year April falls in) for a calendar date. */
  fyStartYearOf(d: Date): number {
    const m = d.getUTCMonth() + 1;
    return m >= 4 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  }

  private label(fyStart: number): string {
    return `${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`;
  }

  private view(d: TaxDeclarationEntity) {
    return {
      id: d.id,
      userId: d.userId,
      financialYearStart: d.financialYearStart,
      financialYear: this.label(d.financialYearStart),
      regime: d.regime,
      section80C: d.section80C,
      section80D: d.section80D,
      section80E: d.section80E,
      homeLoanInterest: d.homeLoanInterest,
      hraExemptionAnnual: d.hraExemptionAnnual,
      otherExemptions: d.otherExemptions,
      proofs: d.proofs || [],
      status: d.status,
      submittedAt: d.submittedAt,
      reviewedBy: d.reviewedBy,
      reviewedAt: d.reviewedAt,
      reviewNote: d.reviewNote,
      editable: d.status === 'draft' || d.status === 'rejected',
      createdAt: d.createdAt,
    };
  }

  private async find(orgId: string, userId: string, fyStart: number) {
    return this.declarations.findOne({
      where: { organizationId: orgId, userId, financialYearStart: fyStart, isDeleted: false },
    });
  }

  /** The caller's declaration for a FY — a fresh draft view when none exists yet. */
  async getMine(orgId: string, userId: string, fyStart: number) {
    const row = await this.find(orgId, userId, fyStart);
    if (row) return this.view(row);
    return {
      id: null,
      userId,
      financialYearStart: fyStart,
      financialYear: this.label(fyStart),
      regime: 'new' as const,
      section80C: 0,
      section80D: 0,
      section80E: 0,
      homeLoanInterest: 0,
      hraExemptionAnnual: 0,
      otherExemptions: 0,
      proofs: [] as TaxProof[],
      status: 'draft' as const,
      submittedAt: null,
      reviewedBy: null,
      reviewedAt: null,
      reviewNote: null,
      editable: true,
      createdAt: null,
    };
  }

  /** Validate each proof references a real file in this org, and normalize it. */
  private async cleanProofs(orgId: string, proofs?: SaveTaxDeclarationDto['proofs']): Promise<TaxProof[]> {
    if (!proofs?.length) return [];
    const out: TaxProof[] = [];
    for (const p of proofs.slice(0, 30)) {
      const file = await this.storage.getMeta(p.fileId).catch(() => null);
      if (!file || file.organizationId !== orgId) {
        throw new BadRequestException(`Proof file ${p.fileId} not found in this organization`);
      }
      out.push({
        fileId: p.fileId,
        name: (p.name || file.originalName).slice(0, 200),
        size: Number(p.size) || file.size || 0,
        section: (p.section || 'other').slice(0, 40),
        uploadedAt: new Date().toISOString(),
      });
    }
    return out;
  }

  /** Create/update the caller's draft. Locked once submitted (until reviewed → rejected). */
  async saveMine(orgId: string, userId: string, fyStart: number, dto: SaveTaxDeclarationDto) {
    let row = await this.find(orgId, userId, fyStart);
    if (row && row.status === 'submitted') {
      throw new ConflictException('Your declaration is submitted and awaiting review — it cannot be edited.');
    }
    if (row && row.status === 'verified') {
      throw new ConflictException('Your declaration is verified and locked for the year.');
    }
    const proofs = await this.cleanProofs(orgId, dto.proofs);
    if (!row) {
      row = this.declarations.create({ organizationId: orgId, userId, financialYearStart: fyStart });
    }
    row.regime = dto.regime === 'old' ? 'old' : 'new';
    row.section80C = this.clamp(dto.section80C);
    row.section80D = this.clamp(dto.section80D);
    row.section80E = this.clamp(dto.section80E);
    row.homeLoanInterest = this.clamp(dto.homeLoanInterest);
    row.hraExemptionAnnual = this.clamp(dto.hraExemptionAnnual);
    row.otherExemptions = this.clamp(dto.otherExemptions);
    row.proofs = proofs;
    // A previously-rejected declaration goes back to draft on edit.
    if (row.status === 'rejected') {
      row.status = 'draft';
      row.reviewNote = null;
      row.reviewedBy = null;
      row.reviewedAt = null;
    }
    const saved = await this.declarations.save(row);
    return this.view(saved);
  }

  private clamp(n?: number): number {
    return Math.max(0, Math.min(100000000, Math.round(Number(n) || 0)));
  }

  /** Submit for review (draft/rejected → submitted). Notifies payroll managers. */
  async submitMine(orgId: string, userId: string, fyStart: number) {
    const row = await this.find(orgId, userId, fyStart);
    if (!row) throw new NotFoundException('Save your declaration before submitting.');
    if (row.status === 'submitted') throw new ConflictException('Already submitted — awaiting review.');
    if (row.status === 'verified') throw new ConflictException('Already verified for the year.');
    row.status = 'submitted';
    row.submittedAt = new Date();
    row.reviewedBy = null;
    row.reviewedAt = null;
    row.reviewNote = null;
    const saved = await this.declarations.save(row);

    await this.notifier.notifyManagers({
      organizationId: orgId,
      resource: 'payroll',
      action: 'edit',
      actorId: userId,
      type: 'tax_declaration_submitted',
      title: 'Tax declaration submitted',
      body: `An employee submitted their ${this.label(fyStart)} investment declaration for review.`,
      data: { actionUrl: '/payroll/declarations', declarationId: saved.id },
    });
    return this.view(saved);
  }

  /** Manager review queue. Defaults to the submitted (pending) declarations. */
  async listForReview(orgId: string, opts: { status?: string; fyStart?: number } = {}) {
    const where: Record<string, unknown> = { organizationId: orgId, isDeleted: false };
    if (opts.status) where.status = opts.status;
    if (opts.fyStart) where.financialYearStart = opts.fyStart;
    const rows = await this.declarations.find({ where, order: { submittedAt: 'DESC', createdAt: 'DESC' } });
    const names = await this.nameMap(orgId, rows.map((r) => r.userId));
    return rows.map((r) => ({ ...this.view(r), employee: names.get(r.userId) || null }));
  }

  /** Verify or reject a submitted declaration (separation of duties: reviewer ≠ declarant, owner exempt). */
  async review(orgId: string, id: string, reviewer: { userId: string; role?: string }, dto: ReviewTaxDeclarationDto) {
    const row = await this.declarations.findOne({ where: { id, organizationId: orgId, isDeleted: false } });
    if (!row) throw new NotFoundException('Declaration not found');
    if (row.status !== 'submitted') {
      throw new ConflictException(`Only a submitted declaration can be reviewed (this one is ${row.status}).`);
    }
    if (row.userId === reviewer.userId && (reviewer.role || '').toLowerCase() !== 'owner') {
      throw new ForbiddenException('Separation of duties — you cannot review your own declaration.');
    }
    row.status = dto.action === 'verify' ? 'verified' : 'rejected';
    row.reviewedBy = reviewer.userId;
    row.reviewedAt = new Date();
    row.reviewNote = dto.note?.slice(0, 500) || null;
    const saved = await this.declarations.save(row);

    await this.notifier.notify({
      organizationId: orgId,
      userId: row.userId,
      actorId: reviewer.userId,
      type: dto.action === 'verify' ? 'tax_declaration_verified' : 'tax_declaration_rejected',
      title: dto.action === 'verify' ? 'Tax declaration verified' : 'Tax declaration needs changes',
      body:
        dto.action === 'verify'
          ? `Your ${this.label(row.financialYearStart)} declaration was verified and will apply to your TDS.`
          : `Your ${this.label(row.financialYearStart)} declaration was returned${row.reviewNote ? `: ${row.reviewNote}` : ''}.`,
      data: { actionUrl: '/payroll/my', declarationId: saved.id },
    });
    return this.view(saved);
  }

  /**
   * Resolved old-regime inputs for TDS: the **verified** declaration for the FY,
   * shaped like TaxInputs. Returns null when there's no verified declaration, so
   * payroll falls back to the salary structure's manager-set inputs.
   */
  async resolvedFor(orgId: string, userId: string, fyStart: number): Promise<{
    regime: 'new' | 'old';
    section80C: number;
    section80D: number;
    section80E: number;
    homeLoanInterest: number;
    hraExemptionAnnual: number;
    otherExemptions: number;
  } | null> {
    const row = await this.declarations.findOne({
      where: { organizationId: orgId, userId, financialYearStart: fyStart, status: 'verified', isDeleted: false },
    });
    if (!row) return null;
    return {
      regime: row.regime,
      section80C: Math.min(row.section80C, CAP_80C),
      section80D: row.section80D,
      section80E: row.section80E,
      homeLoanInterest: Math.min(row.homeLoanInterest, CAP_24B),
      hraExemptionAnnual: row.hraExemptionAnnual,
      otherExemptions: row.otherExemptions,
    };
  }

  private async nameMap(orgId: string, userIds: string[]) {
    const ids = [...new Set(userIds.filter(Boolean))];
    const map = new Map<string, { name: string | null; email: string | null }>();
    if (!ids.length) return map;
    const [mems, users] = await Promise.all([
      this.memberships.find({ where: { organizationId: orgId, userId: In(ids) } }),
      this.users.find({ where: { id: In(ids) } }),
    ]);
    const userById = new Map(users.map((u) => [u.id, u]));
    for (const m of mems) {
      if (!m.userId) continue;
      const u = userById.get(m.userId);
      const name = [u?.firstName, u?.lastName].filter(Boolean).join(' ') || null;
      map.set(m.userId, { name, email: u?.email || null });
    }
    return map;
  }
}
