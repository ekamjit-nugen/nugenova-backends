import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { CandidateApplicationEntity, CandidateEntity } from '../entities';
import { CandidateSource } from '../recruitment.constants';
import {
  cleanCell, cleanList, formatExperience, normalizeEmail, normalizePhone, normalizeSource, parseExperienceMonths,
  looksLikeSheetNote, parseLegacyRemarks, parseNotice, tidyCompany, tidyName,
} from '../recruitment.utils';
import { CandidateFieldsDto, ImportCandidatesDto, ImportRowDto } from '../dto';
import { CandidateListQuery, CandidatesService, POOL_SQL } from './candidates.service';
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

/** Per-import state shared across rows (identity maps, caches, pool tally). */
export interface ImportContext {
  caller: RecruitmentCaller;
  dryRun: boolean;
  defaultSource: CandidateSource;
  extraTags: string[];
  /** 'skip' discards rows matching an existing candidate or an earlier row instead of merging them. */
  duplicates: 'merge' | 'skip';
  skipPossibleDuplicates: boolean;
  stages: Awaited<ReturnType<PipelineService['ensureStages']>>;
  seq: number;
  batch: Map<string, string>;
  batchRows: Map<string, { row: number | null; fullName: string }>;
  nameRows: Map<string, { row: number | null; fullName: string }>;
  openingCache: Map<string, { id: string | null; title: string; created: boolean }>;
  dryApplied: Set<string>;
  leadCache: Map<string, Awaited<ReturnType<SubmissionsService['findLeadTarget']>>>;
  /** candidate key → still in the talent pool after every row that mentions them. */
  pool: Map<string, boolean>;
  /** Preview only: existing candidates fetched up front, so matching costs no per-row queries. */
  existing?: ExistingIndex;
}

type ExistingCandidate = Pick<CandidateEntity, 'id' | 'fullName' | 'email' | 'phone' | 'emailNorm' | 'phoneNorm' | 'currentCompany' | 'status' | 'updatedAt'>;
interface ExistingIndex {
  byEmail: Map<string, ExistingCandidate[]>;
  byPhone: Map<string, ExistingCandidate[]>;
  byName: Map<string, ExistingCandidate[]>;
  unassigned: Set<string>;
  applications: Map<string, Set<string>>;
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

  /**
   * Synchronous import — used for the preview (`dryRun`) and small API imports.
   * The UI commits real files through background jobs (ImportJobsService), which
   * run the very same per-row logic via {@link processRow}.
   */
  async importRows(caller: RecruitmentCaller, dto: ImportCandidatesDto) {
    assertCan(caller, 'create');
    const dryRun = !!dto.dryRun;
    const ctx = await this.createContext(caller, { defaultSource: dto.defaultSource, tags: dto.tags, duplicates: dto.duplicates, skipPossibleDuplicates: dto.skipPossibleDuplicates }, dryRun);
    if (dryRun) ctx.existing = await this.indexExisting(caller.orgId, dto.rows, ctx.defaultSource);
    const results: ImportRowResult[] = [];
    for (const row of dto.rows) results.push(await this.processRow(ctx, row));
    const summary = this.summarize(ctx, results);
    if (!dryRun) {
      this.pipeline.audit(caller, 'recruitment.import', `Imported ${summary.created} new and merged ${summary.merged} candidates`, undefined, summary);
    }
    return { dryRun, summary, results };
  }

  /** Shared state for one import (preview, sync import or a background job). */
  async createContext(
    caller: RecruitmentCaller,
    options: { defaultSource?: string; tags?: string[]; duplicates?: 'merge' | 'skip'; skipPossibleDuplicates?: boolean },
    dryRun: boolean,
  ): Promise<ImportContext> {
    return {
      caller, dryRun,
      defaultSource: (options.defaultSource ?? 'import') as CandidateSource,
      extraTags: cleanList(options.tags ?? [], 10),
      duplicates: options.duplicates === 'skip' ? 'skip' : 'merge',
      skipPossibleDuplicates: !!options.skipPossibleDuplicates,
      stages: await this.pipeline.ensureStages(caller.orgId),
      seq: 0,
      batch: new Map(), batchRows: new Map(), nameRows: new Map(),
      openingCache: new Map(), dryApplied: new Set(), leadCache: new Map(), pool: new Map(),
    };
  }

  /**
   * Re-seed in-file identity after a background job resumes, so rows already
   * saved still count as "earlier rows in this file" (no duplicates on restart).
   */
  rehydrateContext(ctx: ImportContext, done: { payload: ImportRowDto; candidateId: string | null; rowNumber: number | null; talentPool: boolean }[]) {
    for (const d of done) {
      if (!d.candidateId) continue;
      const { fields } = this.normalizeRow(d.payload, ctx.defaultSource);
      if (!fields.fullName) continue;
      for (const k of this.identityKeys(fields)) {
        if (!ctx.batchRows.has(k)) ctx.batchRows.set(k, { row: d.rowNumber, fullName: fields.fullName });
        ctx.batch.set(k, d.candidateId);
      }
      const nameKey = fields.fullName.toLowerCase();
      if (!ctx.nameRows.has(nameKey)) ctx.nameRows.set(nameKey, { row: d.rowNumber, fullName: fields.fullName });
      ctx.pool.set(d.candidateId, (ctx.pool.get(d.candidateId) ?? true) && d.talentPool);
    }
  }

  private identityKeys(fields: CandidateFieldsDto): string[] {
    return [
      fields.email && `e:${fields.email}`,
      fields.phone && `p:${fields.phone}`,
      !fields.email && !fields.phone && fields.fullName && `n:${fields.fullName.toLowerCase()}`,
    ].filter(Boolean) as string[];
  }

  /** Import one row. Never throws — failures are reported on the result. */
  async processRow(ctx: ImportContext, row: ImportRowDto): Promise<ImportRowResult> {
    const { caller, dryRun, extraTags, stages } = ctx;
    const seq = ++ctx.seq;
    const res: ImportRowResult = {
      rowNumber: row.rowNumber ?? null, sheet: row.sheet ?? null, fullName: null, outcome: 'skipped', candidateId: null,
      opening: null, openingCreated: false, appliedToOpening: false, lead: null, submittedToLead: false, talentPool: false, duplicate: null, messages: [],
    };
    try {
      const { fields, openingTitle, notes, stageName, leadName, requirementTitle } = this.normalizeRow(row, ctx.defaultSource);
      res.fullName = fields.fullName ?? null;
      if (!fields.fullName) {
        res.messages.push('Ignored — no candidate name');
        return res;
      }
      // Rows with missing or invalid data are ignored (reported as skipped, never saved).
      if (looksLikeSheetNote(fields.fullName)) {
        res.messages.push(`Ignored — “${fields.fullName.slice(0, 60)}” is a sheet note or total line, not a candidate name`);
        return res;
      }
      if (row.email && cleanCell(row.email) && !fields.email) res.messages.push(`Invalid email "${String(row.email).slice(0, 80)}" left out`);
      if (row.phone && cleanCell(row.phone) && !fields.phone) res.messages.push(`Invalid phone "${String(row.phone).slice(0, 40)}" left out`);
      if (fields.externalResumeUrl && !/^https?:\/\/\S+$/i.test(fields.externalResumeUrl)) {
        res.messages.push(`CV link "${fields.externalResumeUrl.slice(0, 80)}" is not a web link — left out`);
        fields.externalResumeUrl = null;
      }
      if (fields.linkedinUrl && !/^(https?:\/\/)?([\w-]+\.)?linkedin\.com\/\S+$/i.test(fields.linkedinUrl)) {
        res.messages.push(`LinkedIn "${fields.linkedinUrl.slice(0, 80)}" is not a LinkedIn profile link — left out`);
        fields.linkedinUrl = null;
      }
      if (!fields.email && !fields.phone && !fields.externalResumeUrl && !fields.linkedinUrl) {
        res.messages.push('Ignored — no valid email, phone, CV link or LinkedIn to identify this candidate');
        return res;
      }
      if (extraTags.length) fields.tags = extraTags;

      const keys = this.identityKeys(fields);
      const fileKey = keys.find((k) => ctx.batch.has(k));
      let candidateId: string | null = fileKey ? ctx.batch.get(fileKey)! : null;
      const nameKey = fields.fullName.toLowerCase();
      if (fileKey) {
        const earlier = ctx.batchRows.get(fileKey)!;
        const fileMatchId = ctx.batch.get(fileKey)!;
        res.duplicate = {
          kind: 'file', action: 'merged', candidateId: fileMatchId.startsWith('dry:') ? null : fileMatchId, fullName: earlier.fullName, row: earlier.row,
          matchedOn: keys.filter((k) => ctx.batch.get(k) === fileMatchId).map((k) => (k[0] === 'e' ? 'email' : k[0] === 'p' ? 'phone' : 'name')),
        };
        res.messages.push(`Same person as ${earlier.row ? `row ${earlier.row}` : 'an earlier row'} in this file — merged`);
      } else {
        const probe = { email: fields.email ?? null, phone: fields.phone ?? null, name: fields.fullName };
        const { merged, possible } = ctx.existing ? this.matchIndexed(ctx.existing, probe) : await this.candidatesService.matchForImport(caller.orgId, probe);
        if (merged) {
          candidateId = merged.id;
          res.duplicate = { kind: 'existing', action: 'merged', candidateId: merged.id, fullName: merged.fullName, row: null, matchedOn: merged.matchedOn };
        } else if (possible) {
          res.duplicate = { kind: 'existing', action: 'flagged', candidateId: possible.id, fullName: possible.fullName, row: null, matchedOn: possible.matchedOn };
          res.messages.push(`Possible duplicate of existing “${possible.fullName}” (same name, different contact details) — review before importing`);
        } else if (ctx.nameRows.has(nameKey)) {
          const earlier = ctx.nameRows.get(nameKey)!;
          res.duplicate = { kind: 'file', action: 'flagged', candidateId: null, fullName: earlier.fullName, row: earlier.row, matchedOn: ['name'] };
          res.messages.push(`Same name as ${earlier.row ? `row ${earlier.row}` : 'an earlier row'} but different contact details — review before importing`);
        }
      }

      // "Discard duplicates": keep what's already there and drop this row.
      if (candidateId && ctx.duplicates === 'skip') {
        const who = res.duplicate?.kind === 'file' ? `row ${res.duplicate.row ?? '?'} in this file` : `existing “${res.duplicate?.fullName ?? 'candidate'}”`;
        res.messages = [`Discarded — duplicate of ${who} (same ${res.duplicate?.matchedOn.join(' & ') ?? 'details'})`];
        return res;
      }
      if (!candidateId && res.duplicate?.action === 'flagged' && ctx.skipPossibleDuplicates) {
        const who = res.duplicate.kind === 'file' ? `row ${res.duplicate.row ?? '?'} in this file` : `existing “${res.duplicate.fullName}”`;
        res.messages = [`Discarded — possible duplicate of ${who} (same name)`];
        return res;
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
        candidateId = `dry:${seq}`;
        res.outcome = 'created';
      } else {
        const created = await this.candidatesService.create(caller, { ...fields, fullName: fields.fullName } as any);
        candidateId = created.id;
        res.outcome = 'created';
        if (fields.externalResumeUrl) res.messages.push('CV link saved — upload the file on the profile to enable search & AI');
      }
      res.candidateId = candidateId.startsWith('dry:') ? null : candidateId;
      keys.forEach((k) => {
        if (!ctx.batchRows.has(k)) ctx.batchRows.set(k, { row: row.rowNumber ?? null, fullName: fields.fullName! });
        ctx.batch.set(k, candidateId!);
      });
      if (!ctx.nameRows.has(nameKey)) ctx.nameRows.set(nameKey, { row: row.rowNumber ?? null, fullName: fields.fullName });

      if (notes && !dryRun && res.candidateId) {
        await this.pipeline.logActivity(caller.orgId, res.candidateId, 'note', `Imported remark: ${notes}`, { actorId: caller.userId });
      }

      if (openingTitle) {
        const cacheKey = openingTitle.toLowerCase();
        let opening = ctx.openingCache.get(cacheKey);
        if (!opening) {
          opening = await this.openingsService.findOrCreateByTitle(caller, openingTitle, dryRun);
          ctx.openingCache.set(cacheKey, opening);
          res.openingCreated = opening.created;
        }
        res.opening = opening.title;
        const appKey = `${candidateId}|${cacheKey}`;
        if (dryRun) {
          if (!ctx.dryApplied.has(appKey)) {
            const already = opening.id && res.candidateId
              ? (ctx.existing
                ? (ctx.existing.applications.get(res.candidateId)?.has(opening.id) ? 1 : 0)
                : await this.applications.count({ where: { organizationId: caller.orgId, candidateId: res.candidateId, openingId: opening.id, isDeleted: false } }))
              : 0;
            res.appliedToOpening = !already;
            ctx.dryApplied.add(appKey);
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
        let target = ctx.leadCache.get(key);
        if (target === undefined) {
          target = await this.submissions.findLeadTarget(caller.orgId, leadName, requirementTitle);
          ctx.leadCache.set(key, target);
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
            res.submittedToLead = !ctx.dryApplied.has(subKey);
            ctx.dryApplied.add(subKey);
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

      // Talent pool = the candidate ends up in no opening and no client lead. A merged
      // person may already be in a pipeline, and a later row may place them somewhere.
      let pooled = !openingTitle && !res.lead;
      if (pooled && res.outcome === 'merged' && res.candidateId) {
        pooled = ctx.existing ? ctx.existing.unassigned.has(res.candidateId) : await this.isUnassigned(caller.orgId, res.candidateId);
      }
      res.talentPool = pooled;
      ctx.pool.set(candidateId, (ctx.pool.get(candidateId) ?? true) && pooled);
    } catch (err: any) {
      res.outcome = 'error';
      res.messages.push(err?.response?.message ?? err?.message ?? 'Unexpected error');
    }
    return res;
  }

  /**
   * Fetch every existing candidate any row could match (email, phone or exact name)
   * in a few set-based queries — the preview then runs without per-row lookups.
   */
  private async indexExisting(orgId: string, rows: ImportRowDto[], defaultSource: CandidateSource): Promise<ExistingIndex> {
    const emails = new Set<string>();
    const phones = new Set<string>();
    const names = new Set<string>();
    for (const row of rows) {
      const { fields } = this.normalizeRow(row, defaultSource);
      if (fields.email) emails.add(fields.email);
      if (fields.phone) phones.add(fields.phone);
      if (fields.fullName) names.add(fields.fullName.toLowerCase());
    }
    const index: ExistingIndex = { byEmail: new Map(), byPhone: new Map(), byName: new Map(), unassigned: new Set(), applications: new Map() };
    if (!emails.size && !phones.size && !names.size) return index;
    const found: ExistingCandidate[] = await this.candidates.createQueryBuilder('c')
      .select(['c.id', 'c.fullName', 'c.email', 'c.phone', 'c.emailNorm', 'c.phoneNorm', 'c.currentCompany', 'c.status', 'c.updatedAt'])
      .where('c.organization_id = :orgId AND c.is_deleted = false', { orgId })
      .andWhere('(c.email_norm = ANY(:emails) OR c.phone_norm = ANY(:phones) OR lower(c.full_name) = ANY(:names))', {
        emails: [...emails], phones: [...phones], names: [...names],
      })
      .orderBy('c.updated_at', 'DESC')
      .getMany();
    const push = (m: Map<string, ExistingCandidate[]>, k: string | null | undefined, c: ExistingCandidate) => {
      if (!k) return;
      const list = m.get(k);
      if (list) list.push(c); else m.set(k, [c]);
    };
    for (const c of found) {
      push(index.byEmail, c.emailNorm, c);
      push(index.byPhone, c.phoneNorm, c);
      push(index.byName, c.fullName.toLowerCase(), c);
    }
    const ids = found.map((c) => c.id);
    if (ids.length) {
      const pooled = await this.candidates.createQueryBuilder('c').select('c.id', 'id')
        .where('c.organization_id = :orgId AND c.id = ANY(:ids)', { orgId, ids })
        .andWhere(POOL_SQL.unassigned)
        .getRawMany<{ id: string }>();
      pooled.forEach((r) => index.unassigned.add(r.id));
      const apps = await this.applications.createQueryBuilder('a').select(['a.candidateId', 'a.openingId'])
        .where('a.organization_id = :orgId AND a.is_deleted = false AND a.candidate_id = ANY(:ids)', { orgId, ids })
        .getMany();
      for (const a of apps) {
        const set = index.applications.get(a.candidateId) ?? new Set<string>();
        set.add(a.openingId);
        index.applications.set(a.candidateId, set);
      }
    }
    return index;
  }

  /** Same rules as CandidatesService.matchForImport, answered from the preview index. */
  private matchIndexed(index: ExistingIndex, probe: { email: string | null; phone: string | null; name: string | null }) {
    const name = probe.name?.trim().toLowerCase() || null;
    const seen = new Map<string, ExistingCandidate>();
    for (const c of [
      ...(probe.email ? index.byEmail.get(probe.email) ?? [] : []),
      ...(probe.phone ? index.byPhone.get(probe.phone) ?? [] : []),
      ...(name ? index.byName.get(name) ?? [] : []),
    ]) seen.set(c.id, c);
    const matches = [...seen.values()]
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, 10)
      .map((c) => ({
        id: c.id, fullName: c.fullName, email: c.email, phone: c.phone,
        matchedOn: [
          ...(probe.email && c.emailNorm === probe.email ? ['email' as const] : []),
          ...(probe.phone && c.phoneNorm === probe.phone ? ['phone' as const] : []),
          ...(name && c.fullName.toLowerCase() === name ? ['name' as const] : []),
        ],
      }));
    const merged = matches.find((m) => m.matchedOn.includes('email'))
      ?? matches.find((m) => m.matchedOn.includes('phone'))
      ?? (!probe.email && !probe.phone ? matches.find((m) => m.matchedOn.includes('name') && !m.email && !m.phone) : undefined)
      ?? null;
    const possible = merged ? null : matches.find((m) => m.matchedOn.includes('name')) ?? null;
    return { merged, possible };
  }

  private async isUnassigned(orgId: string, candidateId: string): Promise<boolean> {
    const n = await this.candidates.createQueryBuilder('c')
      .where('c.id = :candidateId AND c.organization_id = :orgId', { candidateId, orgId })
      .andWhere(POOL_SQL.unassigned)
      .getCount();
    return n > 0;
  }

  /** Totals for a finished (or previewed) set of rows. People, not rows, are counted for the pool. */
  summarize(ctx: ImportContext, results: ImportRowResult[]) {
    return {
      rows: results.length,
      created: results.filter((r) => r.outcome === 'created').length,
      merged: results.filter((r) => r.outcome === 'merged').length,
      skipped: results.filter((r) => r.outcome === 'skipped').length,
      errors: results.filter((r) => r.outcome === 'error').length,
      openingsCreated: [...ctx.openingCache.values()].filter((o) => o.created).map((o) => o.title),
      applications: results.filter((r) => r.appliedToOpening).length,
      submissions: results.filter((r) => r.submittedToLead).length,
      talentPool: [...ctx.pool.values()].filter(Boolean).length,
      duplicatesMerged: results.filter((r) => r.duplicate?.action === 'merged').length,
      duplicatesFlagged: results.filter((r) => r.duplicate?.action === 'flagged').length,
    };
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
