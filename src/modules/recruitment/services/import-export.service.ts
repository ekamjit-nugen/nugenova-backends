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
import { SubmissionsService } from './submissions.service';
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
  /** "Acme — Senior Data Engineer" when the row was shortlisted against a client lead. */
  lead: string | null;
  submittedToLead: boolean;
  /** No opening and no lead → the candidate sits in the talent pool. */
  talentPool: boolean;
  /** Duplicate detection shown in the preview: merged into a match, or flagged for review. */
  duplicate: {
    kind: 'existing' | 'file';
    action: 'merged' | 'flagged';
    matchedOn: ('email' | 'phone' | 'name')[];
    candidateId: string | null;
    fullName: string;
    row: number | null;
  } | null;
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
    private readonly submissions: SubmissionsService,
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
    return { fields, openingTitle, notes: remarks.notes, stageName: cleanCell(row.stage), leadName: cleanCell(row.lead), requirementTitle: cleanCell(row.requirement) };
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
    const batchRows = new Map<string, { row: number | null; fullName: string }>();
    const nameRows = new Map<string, { row: number | null; fullName: string }>();
    const openingCache = new Map<string, { id: string | null; title: string; created: boolean }>();
    const dryApplied = new Set<string>();
    const leadCache = new Map<string, Awaited<ReturnType<SubmissionsService['findLeadTarget']>>>();

    for (const row of dto.rows) {
      const res: ImportRowResult = {
        rowNumber: row.rowNumber ?? null, sheet: row.sheet ?? null, fullName: null, outcome: 'skipped', candidateId: null,
        opening: null, openingCreated: false, appliedToOpening: false, lead: null, submittedToLead: false, talentPool: false, duplicate: null, messages: [],
      };
      results.push(res);
      try {
        const { fields, openingTitle, notes, stageName, leadName, requirementTitle } = this.normalizeRow(row, defaultSource);
        res.fullName = fields.fullName ?? null;
        if (!fields.fullName) {
          res.messages.push('No candidate name — row skipped');
          continue;
        }
        if (row.email && cleanCell(row.email) && !fields.email) res.messages.push(`Ignored invalid email "${row.email}"`);
        if (row.phone && cleanCell(row.phone) && !fields.phone) res.messages.push(`Ignored invalid phone "${row.phone}"`);
        if (extraTags.length) fields.tags = extraTags;

        const keys = [fields.email && `e:${fields.email}`, fields.phone && `p:${fields.phone}`, !fields.email && !fields.phone && `n:${fields.fullName.toLowerCase()}`].filter(Boolean) as string[];
        const fileKey = keys.find((k) => batch.has(k));
        let candidateId: string | null = fileKey ? batch.get(fileKey)! : null;
        const nameKey = fields.fullName.toLowerCase();
        if (fileKey) {
          const earlier = batchRows.get(fileKey)!;
          const fileMatchId = batch.get(fileKey)!;
          res.duplicate = {
            kind: 'file', action: 'merged', candidateId: fileMatchId.startsWith('dry:') ? null : fileMatchId, fullName: earlier.fullName, row: earlier.row,
            matchedOn: keys.filter((k) => batch.get(k) === fileMatchId).map((k) => (k[0] === 'e' ? 'email' : k[0] === 'p' ? 'phone' : 'name')),
          };
          res.messages.push(`Same person as ${earlier.row ? `row ${earlier.row}` : 'an earlier row'} in this file — merged`);
        } else {
          const { merged, possible } = await this.candidatesService.matchForImport(caller.orgId, { email: fields.email ?? null, phone: fields.phone ?? null, name: fields.fullName });
          if (merged) {
            candidateId = merged.id;
            res.duplicate = { kind: 'existing', action: 'merged', candidateId: merged.id, fullName: merged.fullName, row: null, matchedOn: merged.matchedOn };
          } else if (possible) {
            res.duplicate = { kind: 'existing', action: 'flagged', candidateId: possible.id, fullName: possible.fullName, row: null, matchedOn: possible.matchedOn };
            res.messages.push(`Possible duplicate of existing “${possible.fullName}” (same name, different contact details) — review before importing`);
          } else if (nameRows.has(nameKey)) {
            const earlier = nameRows.get(nameKey)!;
            res.duplicate = { kind: 'file', action: 'flagged', candidateId: null, fullName: earlier.fullName, row: earlier.row, matchedOn: ['name'] };
            res.messages.push(`Same name as ${earlier.row ? `row ${earlier.row}` : 'an earlier row'} but different contact details — review before importing`);
          }
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
        keys.forEach((k) => {
          if (!batchRows.has(k)) batchRows.set(k, { row: row.rowNumber ?? null, fullName: fields.fullName! });
          batch.set(k, candidateId!);
        });
        if (!nameRows.has(nameKey)) nameRows.set(nameKey, { row: row.rowNumber ?? null, fullName: fields.fullName });

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

        if (leadName) {
          const key = `${leadName.toLowerCase()}|${(requirementTitle ?? '').toLowerCase()}`;
          let target = leadCache.get(key);
          if (target === undefined) {
            target = await this.submissions.findLeadTarget(caller.orgId, leadName, requirementTitle);
            leadCache.set(key, target);
          }
          if (!target) {
            res.messages.push(`Lead “${leadName}” not found — create it in Sales first; candidate kept in the talent pool`);
          } else if (target.requirementMissing) {
            res.messages.push(`Requirement “${requirementTitle}” not found on ${target.label} — shortlisted against the lead`);
          }
          if (target) {
            res.lead = target.label;
            const subKey = `${candidateId}|${target.leadId}|${target.requirementId ?? ''}`;
            if (dryRun) {
              res.submittedToLead = !dryApplied.has(subKey);
              dryApplied.add(subKey);
            } else if (res.candidateId) {
              try {
                await this.submissions.create(caller, { leadId: target.leadId, requirementId: target.requirementId ?? undefined, candidateId: res.candidateId, note: 'Imported from spreadsheet' }, { silentNotify: true });
                res.submittedToLead = true;
              } catch (e: any) {
                if (e?.status !== 409) res.messages.push(e?.response?.message ?? e?.message ?? 'Could not shortlist against the lead');
              }
            }
          }
        }
        res.talentPool = !openingTitle && !res.lead;
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
      submissions: results.filter((r) => r.submittedToLead).length,
      talentPool: results.filter((r) => r.talentPool && (r.outcome === 'created' || r.outcome === 'merged')).length,
      duplicatesMerged: results.filter((r) => r.duplicate?.action === 'merged').length,
      duplicatesFlagged: results.filter((r) => r.duplicate?.action === 'flagged').length,
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
