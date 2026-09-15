import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { CandidateApplicationEntity, CandidateEntity } from '../entities';
import { CandidateSource } from '../recruitment.constants';
import {
  cleanCell, cleanList, formatExperience, normalizeEmail, normalizePhone, normalizeSource, parseExperienceMonths,
  parseLegacyRemarks, parseNotice, tidyCompany, tidyName,
} from '../recruitment.utils';
import { CandidateFieldsDto, ImportCandidatesDto, ImportRowDto } from '../dto';
import { CandidateListQuery, CandidatesService } from './candidates.service';
import { OpeningsService } from './openings.service';
import { PipelineService } from './pipeline.service';
import { RecruitmentCaller, assertCan } from './recruitment-caller';

export type ImportOutcome = 'created' | 'merged' | 'skipped' | 'error';

export interface ImportRowResult {
  rowNumber: number | null;
  sheet: string | null;
  fullName: string | null;
  outcome: ImportOutcome;
  candidateId: string | null;
  opening: string | null;
  openingCreated: boolean;
  appliedToOpening: boolean;
  messages: string[];
}

const numberish = (v: unknown): number | null => {
  const s = cleanCell(v);
  if (!s) return null;
  const lakh = s.match(/([\d.]+)\s*(l|lpa|lakhs?|lacs?)\b/i);
  if (lakh) return Math.round(parseFloat(lakh[1]) * 100_000);
  const cr = s.match(/([\d.]+)\s*(cr|crores?)\b/i);
  if (cr) return Math.round(parseFloat(cr[1]) * 10_000_000);
  const n = parseFloat(s.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * Spreadsheet import (the team's Excel migration path) and export.
 * The frontend only maps columns; every clean-up rule lives here:
 * "—" → blank, "5+ years" → 60 months, "Immediate" → 0 days, `[Role] Source: …`
 * remarks split into opening + source + notes, duplicates across sheets merged
 * by email → phone → (contact-less) name.
 */
@Injectable()
export class ImportExportService {
  constructor(
    @InjectRepository(CandidateApplicationEntity) private readonly applications: Repository<CandidateApplicationEntity>,
    @InjectRepository(CandidateEntity) private readonly candidates: Repository<CandidateEntity>,
    private readonly candidatesService: CandidatesService,
    private readonly openingsService: OpeningsService,
    private readonly pipeline: PipelineService,
  ) {}

  /** Normalise one spreadsheet row into profile fields + side info. */
  normalizeRow(row: ImportRowDto, defaultSource: CandidateSource) {
    const remarks = parseLegacyRemarks(row.remarks);
    const notice = parseNotice(row.noticePeriod);
    const explicitSource = normalizeSource(row.source);
    const openingTitle = cleanCell(row.opening) ?? remarks.role;
    const fields: CandidateFieldsDto = {
      fullName: tidyName(row.fullName) ?? undefined,
      email: normalizeEmail(row.email),
      phone: normalizePhone(row.phone),
      highestQualification: cleanCell(row.qualification)?.replace(/^[•\-\s]+/, '').slice(0, 200) ?? null,
      totalExpMonths: parseExperienceMonths(row.experience),
      currentCompany: tidyCompany(row.currentCompany),
      currentDesignation: cleanCell(row.currentDesignation),
      noticePeriodDays: notice.days,
      noticeStatus: notice.status,
      currentLocation: cleanCell(row.currentLocation),
      skills: cleanList(row.skills ?? ''),
      currentCtc: numberish(row.currentCtc),
      expectedCtc: numberish(row.expectedCtc),
      linkedinUrl: cleanCell(row.linkedinUrl),
      externalResumeUrl: cleanCell(row.resumeUrl),
      source: explicitSource ?? defaultSource,
      sourceDetail: remarks.sourceLabel && remarks.sourceLabel.toLowerCase() !== 'resume' ? remarks.sourceLabel.slice(0, 200) : null,
    };
    return { fields, openingTitle, notes: remarks.notes, stageName: cleanCell(row.stage) };
  }

  async importRows(caller: RecruitmentCaller, dto: ImportCandidatesDto) {
    assertCan(caller, 'create');
    const dryRun = !!dto.dryRun;
    const defaultSource = (dto.defaultSource ?? 'import') as CandidateSource;
    const extraTags = cleanList(dto.tags ?? [], 10);
    const stages = await this.pipeline.ensureStages(caller.orgId);
    const results: ImportRowResult[] = [];
    // In-batch identity so the same person on two sheets is merged even in a dry run.
    const batch = new Map<string, string>();
    const openingCache = new Map<string, { id: string | null; title: string; created: boolean }>();
    const dryApplied = new Set<string>();

    for (const row of dto.rows) {
      const res: ImportRowResult = {
        rowNumber: row.rowNumber ?? null, sheet: row.sheet ?? null, fullName: null, outcome: 'skipped', candidateId: null,
        opening: null, openingCreated: false, appliedToOpening: false, messages: [],
      };
      results.push(res);
      try {
        const { fields, openingTitle, notes, stageName } = this.normalizeRow(row, defaultSource);
        res.fullName = fields.fullName ?? null;
        if (!fields.fullName) {
          res.messages.push('No candidate name — row skipped');
          continue;
        }
        if (row.email && cleanCell(row.email) && !fields.email) res.messages.push(`Ignored invalid email "${row.email}"`);
        if (row.phone && cleanCell(row.phone) && !fields.phone) res.messages.push(`Ignored invalid phone "${row.phone}"`);
        if (extraTags.length) fields.tags = extraTags;

        const keys = [fields.email && `e:${fields.email}`, fields.phone && `p:${fields.phone}`, !fields.email && !fields.phone && `n:${fields.fullName.toLowerCase()}`].filter(Boolean) as string[];
        let candidateId = keys.map((k) => batch.get(k)).find(Boolean) ?? null;
        if (!candidateId) {
          const existing = await this.candidatesService.findExisting(caller.orgId, { email: fields.email ?? null, phone: fields.phone ?? null, name: fields.fullName });
          candidateId = existing?.id ?? null;
        }

        if (candidateId) {
          res.outcome = 'merged';
          if (!dryRun && !candidateId.startsWith('dry:')) {
            const c = await this.pipeline.requireCandidate(caller.orgId, candidateId);
            const before = JSON.stringify(c);
            this.candidatesService.applyFields(c, { ...fields, source: undefined, tags: undefined }, true);
            if (!c.email && fields.email) { c.email = fields.email; c.emailNorm = fields.email; }
            if (!c.phone && fields.phone) { c.phone = fields.phone; c.phoneNorm = fields.phone; }
            if (extraTags.length) c.tags = cleanList([...(c.tags ?? []), ...extraTags], 30);
            // A later sheet may list more experience (newer snapshot) — keep the larger value.
            if (fields.totalExpMonths != null && (c.totalExpMonths ?? 0) < fields.totalExpMonths) c.totalExpMonths = fields.totalExpMonths;
            if (JSON.stringify(c) !== before) {
              try {
                await this.candidates.save(c);
              } catch {
                res.messages.push('Contact details clash with another candidate — kept existing values');
              }
            }
          }
          res.messages.push('Matched an existing candidate — filled in blank fields only');
        } else if (dryRun) {
          candidateId = `dry:${results.length}`;
          res.outcome = 'created';
        } else {
          const created = await this.candidatesService.create(caller, { ...fields, fullName: fields.fullName } as any);
          candidateId = created.id;
          res.outcome = 'created';
          if (fields.externalResumeUrl) res.messages.push('CV link saved — upload the file on the profile to enable search & AI');
        }
        res.candidateId = candidateId.startsWith('dry:') ? null : candidateId;
        keys.forEach((k) => batch.set(k, candidateId!));

        if (notes && !dryRun && res.candidateId) {
          await this.pipeline.logActivity(caller.orgId, res.candidateId, 'note', `Imported remark: ${notes}`, { actorId: caller.userId });
        }

        if (openingTitle) {
          const cacheKey = openingTitle.toLowerCase();
          let opening = openingCache.get(cacheKey);
          if (!opening) {
            opening = await this.openingsService.findOrCreateByTitle(caller, openingTitle, dryRun);
            openingCache.set(cacheKey, opening);
            res.openingCreated = opening.created;
          }
          res.opening = opening.title;
          const appKey = `${candidateId}|${cacheKey}`;
          if (dryRun) {
            if (!dryApplied.has(appKey)) {
              const already = opening.id && res.candidateId
                ? await this.applications.count({ where: { organizationId: caller.orgId, candidateId: res.candidateId, openingId: opening.id, isDeleted: false } })
                : 0;
              res.appliedToOpening = !already;
              dryApplied.add(appKey);
            }
          } else if (opening.id && res.candidateId) {
            const already = await this.applications.count({ where: { organizationId: caller.orgId, candidateId: res.candidateId, openingId: opening.id, isDeleted: false } });
            if (!already) {
              const stage = stageName ? stages.find((s) => s.name.toLowerCase() === stageName.toLowerCase()) : undefined;
              await this.pipeline.createApplication(caller, { candidateId: res.candidateId, openingId: opening.id, stageId: stage?.id }, { note: 'Imported from spreadsheet' });
              res.appliedToOpening = true;
            }
          }
        }
      } catch (err: any) {
        res.outcome = 'error';
        res.messages.push(err?.response?.message ?? err?.message ?? 'Unexpected error');
      }
    }

    const summary = {
      rows: results.length,
      created: results.filter((r) => r.outcome === 'created').length,
      merged: results.filter((r) => r.outcome === 'merged').length,
      skipped: results.filter((r) => r.outcome === 'skipped').length,
      errors: results.filter((r) => r.outcome === 'error').length,
      openingsCreated: [...openingCache.values()].filter((o) => o.created).map((o) => o.title),
      applications: results.filter((r) => r.appliedToOpening).length,
    };
    if (!dryRun) {
      this.pipeline.audit(caller, 'recruitment.import', `Imported ${summary.created} new and merged ${summary.merged} candidates`, undefined, summary);
    }
    return { dryRun, summary, results };
  }

  /** Flat rows for an Excel export honouring the list filters. */
  async exportRows(caller: RecruitmentCaller, f: CandidateListQuery) {
    assertCan(caller, 'export');
    const { items, total } = await this.candidatesService.list(caller, { ...f, page: 1, limit: 10_000 }, { maxLimit: 10_000 });
    const ids = items.map((i) => i.id);
    const withText = ids.length ? await this.candidates.find({ where: { id: In(ids) }, select: { id: true, education: true } }) : [];
    const eduById = new Map(withText.map((c) => [c.id, c.education]));
    const rows = items.map((c) => ({
      'Candidate Name': c.fullName,
      'Email': c.email ?? '',
      'Phone': c.phone ?? '',
      'Current Location': c.currentLocation ?? '',
      'Experience': formatExperience(c.totalExpMonths),
      'Experience (months)': c.totalExpMonths ?? '',
      'Current Company': c.currentCompany ?? '',
      'Designation': c.currentDesignation ?? '',
      'Notice Period (days)': c.noticePeriodDays ?? (c.noticeStatus === 'immediate' ? 0 : ''),
      'Notice Status': c.noticeStatus,
      'Current CTC': c.currentCtc ?? '',
      'Expected CTC': c.expectedCtc ?? '',
      'Qualification': c.highestQualification ?? (eduById.get(c.id)?.[0]?.degree ?? ''),
      'Skills': (c.skills ?? []).join(', '),
      'Source': c.source + (c.sourceDetail ? ` (${c.sourceDetail})` : ''),
      'Openings': c.applications.map((a) => `${a.openingTitle}: ${a.stageName}`).join('; '),
      'Status': c.status,
      'Owner': c.ownerName ?? '',
      'Tags': (c.tags ?? []).join(', '),
      'Rating': c.rating ?? '',
      'LinkedIn': c.linkedinUrl ?? '',
      'CV': c.primaryResume?.fileName ?? (c.externalResumeUrl ?? ''),
      'Added On': new Date(c.createdAt).toISOString().slice(0, 10),
      'Last Activity': c.lastActivityAt ? new Date(c.lastActivityAt).toISOString().slice(0, 10) : '',
    }));
    this.pipeline.audit(caller, 'recruitment.export', `Exported ${rows.length} candidates`, undefined, { total, filters: f as Record<string, unknown> });
    return { rows, total, filename: `candidates-${new Date().toISOString().slice(0, 10)}.xlsx` };
  }
}
