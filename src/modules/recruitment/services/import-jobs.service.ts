import { hostname } from 'os';
import { randomBytes } from 'crypto';
import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';

import { newObjectId } from '../../../bootstrap/database/object-id';
import { CreateImportJobDto, ImportRowDto } from '../dto';
import { CandidateSource } from '../recruitment.constants';
import { RecruitmentImportJobEntity, RecruitmentImportRowEntity } from '../entities';
import type { ImportJobStatus, ImportRowStatus } from '../entities';
import { RECRUITMENT_NOTIFICATIONS } from '../recruitment.constants';
import { ImportContext, ImportExportService, ImportRowResult } from './import-export.service';
import { PipelineService } from './pipeline.service';
import { RecruitmentCaller, assertCan, can } from './recruitment-caller';

/** Rows handled between counter refreshes / heartbeats / cancel checks. */
const BATCH_SIZE = 25;
/** A processing job whose heartbeat is older than this is considered abandoned and is resumed. */
const LEASE_SECONDS = 90;
/** A job restarted this many times is failed instead of retried forever. */
const MAX_JOB_ATTEMPTS = 5;
/** A row that crashed the worker this many times is reported as an error. */
const MAX_ROW_ATTEMPTS = 3;
const POLL_MS = Number(process.env.RECRUITMENT_IMPORT_POLL_MS || 5000);
const INSERT_CHUNK = 500;
/** A file with at least this share of unusable rows is refused outright — it is the wrong file or badly mapped. */
const BAD_FILE_RATIO = 0.25;

type RowFilter = 'issues' | 'error' | 'skipped' | 'flagged' | 'all';

/** The first few row problems, e.g. 'row 4: … is not a valid email address'. */
function describeIssues(issues: { row: ImportRowDto; issue: string }[]): string {
  const shown = issues.slice(0, 3).map((x) => `row ${x.row.rowNumber ?? '?'}: ${x.issue.replace(/^Ignored — /, '')}`);
  return shown.join('; ') + (issues.length > shown.length ? ` (+${issues.length - shown.length} more)` : '');
}

/** TypeORM returns `[rows, affected]` for UPDATE … RETURNING on Postgres, and plain rows for SELECT. */
function returningRows<T>(out: unknown): T[] {
  if (Array.isArray(out) && out.length === 2 && Array.isArray(out[0]) && typeof out[1] === 'number') return out[0] as T[];
  return Array.isArray(out) ? (out as T[]) : [];
}

/**
 * Background spreadsheet imports.
 *
 * `enqueue` stores the mapped rows and returns immediately (HTTP 202). A worker
 * in every API instance claims queued jobs with `FOR UPDATE SKIP LOCKED` (one
 * running job per organization), saves each row on its own, and refreshes the
 * job's counters every few rows so the dashboard shows live progress. A job
 * whose worker died (deploy, crash) is resumed from its unprocessed rows once
 * its lease expires. Re-sending the same idempotency key returns the same job.
 */
@Injectable()
export class ImportJobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ImportJobsService.name);
  private readonly workerId = `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;

  constructor(
    @InjectRepository(RecruitmentImportJobEntity) private readonly jobs: Repository<RecruitmentImportJobEntity>,
    @InjectRepository(RecruitmentImportRowEntity) private readonly rows: Repository<RecruitmentImportRowEntity>,
    private readonly dataSource: DataSource,
    private readonly importer: ImportExportService,
    private readonly pipeline: PipelineService,
  ) {}

  // ── lifecycle ─────────────────────────────────────────────────────────────────

  onModuleInit() {
    if (process.env.RECRUITMENT_IMPORT_WORKER === 'off') return;
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    this.timer.unref?.();
  }

  /** Graceful shutdown: finish the row in flight, then hand the job back so another instance resumes at once. */
  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const until = Date.now() + 10_000;
    while (this.running && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  }

  /** Start work now instead of waiting for the next poll. */
  kick() {
    if (process.env.RECRUITMENT_IMPORT_WORKER === 'off') return;
    setImmediate(() => void this.tick());
  }

  // ── API ───────────────────────────────────────────────────────────────────────

  async enqueue(caller: RecruitmentCaller, dto: CreateImportJobDto) {
    assertCan(caller, 'create');
    const key = dto.idempotencyKey?.trim() || null;
    if (key) {
      const existing = await this.jobs.findOne({ where: { organizationId: caller.orgId, idempotencyKey: key } });
      if (existing) return { job: await this.view(existing), duplicate: true };
    }
    // Pre-flight: never import a file whose rows carry wrong data.
    const issues = dto.rows.map((r) => ({ row: r, issue: this.importer.rowIssue(r, (dto.defaultSource ?? 'import') as CandidateSource) }))
      .filter((x): x is { row: ImportRowDto; issue: string } => !!x.issue);
    const usable = dto.rows.length - issues.length;
    if (!usable) {
      throw new BadRequestException(`Nothing in this file can be imported — ${describeIssues(issues)}. Fix the file and preview it again.`);
    }
    if (issues.length / dto.rows.length >= BAD_FILE_RATIO) {
      throw new BadRequestException(
        `${issues.length} of ${dto.rows.length} rows carry wrong or missing data, so the file was not imported — ${describeIssues(issues)}. `
        + 'Fix the file (or map the right columns) and preview it again.',
      );
    }

    const jobId = newObjectId();
    try {
      await this.dataSource.transaction(async (m) => {
        await m.insert(RecruitmentImportJobEntity, {
          id: jobId, organizationId: caller.orgId, createdBy: caller.userId,
          caller: { userId: caller.userId, orgId: caller.orgId, isAdmin: caller.isAdmin, actions: caller.actions },
          fileName: dto.fileName.trim().slice(0, 255) || 'Spreadsheet', fileSize: dto.fileSize ?? null,
          sheetNames: [...new Set(dto.rows.map((r) => r.sheet).filter((s): s is string => typeof s === 'string' && !!s))].slice(0, 100) as string[],
          idempotencyKey: key, status: 'queued', options: { defaultSource: dto.defaultSource, tags: dto.tags ?? [], duplicates: dto.duplicates ?? 'merge', skipPossibleDuplicates: !!dto.skipPossibleDuplicates },
          totalRows: dto.rows.length,
        });
        for (let i = 0; i < dto.rows.length; i += INSERT_CHUNK) {
          await m.insert(RecruitmentImportRowEntity, dto.rows.slice(i, i + INSERT_CHUNK).map((r, j) => ({
            id: newObjectId(), organizationId: caller.orgId, jobId, idx: i + j,
            sheet: r.sheet?.slice(0, 200) ?? null, rowNumber: r.rowNumber ?? null,
            payload: r as unknown as Record<string, unknown>, status: 'pending' as ImportRowStatus,
          })) as any);
        }
      });
    } catch (err: any) {
      // Same key raced in from a second click/tab: hand back the job that won.
      if (key && err?.code === '23505') {
        const existing = await this.jobs.findOne({ where: { organizationId: caller.orgId, idempotencyKey: key } });
        if (existing) return { job: await this.view(existing), duplicate: true };
      }
      throw err;
    }
    this.pipeline.audit(caller, 'recruitment.import_started', `Started importing ${dto.rows.length} rows from "${dto.fileName}"`, { type: 'import', id: jobId });
    this.kick();
    return { job: await this.view(await this.requireJob(caller.orgId, jobId)), duplicate: false };
  }

  /** Recent imports for the dashboard: everything running, plus the last week's finished ones not dismissed. */
  async list(caller: RecruitmentCaller, q: { limit?: number; includeDismissed?: boolean } = {}) {
    assertCan(caller, 'view');
    const limit = Math.min(Math.max(Number(q.limit) || 10, 1), 50);
    const qb = this.jobs.createQueryBuilder('j')
      .where('j.organization_id = :orgId', { orgId: caller.orgId })
      .andWhere(`(j.status IN ('queued','processing') OR j.created_at > now() - interval '7 days')`);
    if (!q.includeDismissed) qb.andWhere('j.dismissed_at IS NULL');
    const rows = await qb.orderBy(`CASE WHEN j.status IN ('queued','processing') THEN 0 ELSE 1 END`, 'ASC').addOrderBy('j.created_at', 'DESC').take(limit).getMany();
    return this.views(rows);
  }

  async get(caller: RecruitmentCaller, id: string) {
    assertCan(caller, 'view');
    return this.view(await this.requireJob(caller.orgId, id));
  }

  /** Row results — by default only the rows that need attention (errors, skips, flagged duplicates). */
  async listRows(caller: RecruitmentCaller, id: string, q: { filter?: string; page?: number; limit?: number }) {
    assertCan(caller, 'view');
    await this.requireJob(caller.orgId, id);
    const filter = (['issues', 'error', 'skipped', 'flagged', 'all'].includes(q.filter ?? '') ? q.filter : 'issues') as RowFilter;
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    const page = Math.max(Number(q.page) || 1, 1);
    const qb = this.rows.createQueryBuilder('r').where('r.job_id = :id AND r.organization_id = :orgId', { id, orgId: caller.orgId });
    if (filter === 'error') qb.andWhere(`r.status = 'error'`);
    else if (filter === 'skipped') qb.andWhere(`r.status = 'skipped'`);
    else if (filter === 'flagged') qb.andWhere(`r.duplicate->>'action' = 'flagged'`);
    else if (filter === 'issues') qb.andWhere(`(r.status IN ('error','skipped') OR r.duplicate->>'action' = 'flagged')`);
    const [items, total] = await qb.orderBy('r.idx', 'ASC').skip((page - 1) * limit).take(limit).getManyAndCount();
    return {
      items: items.map((r) => ({
        id: r.id, idx: r.idx, sheet: r.sheet, rowNumber: r.rowNumber, status: r.status, outcome: r.outcome, fullName: r.fullName ?? (r.payload?.fullName as string) ?? null,
        candidateId: r.candidateId, opening: r.opening, lead: r.lead, duplicate: r.duplicate, messages: r.messages ?? [], processedAt: r.processedAt,
      })),
      total, page, limit, filter,
    };
  }

  async cancel(caller: RecruitmentCaller, id: string) {
    const job = await this.requireJob(caller.orgId, id);
    this.assertOwnerOrEditor(caller, job, 'cancel');
    if (job.status === 'queued') {
      await this.jobs.update({ id, status: 'queued' }, { status: 'cancelled', cancelRequested: true, finishedAt: new Date() });
    } else if (job.status === 'processing') {
      await this.jobs.update({ id }, { cancelRequested: true });
    } else {
      throw new ConflictException('This import has already finished');
    }
    this.pipeline.audit(caller, 'recruitment.import_cancelled', `Cancelled import of "${job.fileName}"`, { type: 'import', id });
    return this.view(await this.requireJob(caller.orgId, id));
  }

  /** Re-run rows that failed (and any never reached after a cancel). Saved rows are not touched. */
  async retry(caller: RecruitmentCaller, id: string) {
    assertCan(caller, 'create');
    const job = await this.requireJob(caller.orgId, id);
    this.assertOwnerOrEditor(caller, job, 'retry');
    if (job.status === 'queued' || job.status === 'processing') throw new ConflictException('This import is still running');
    const reset = await this.rows.update({ jobId: id, status: In(['error', 'processing']) as any }, { status: 'pending', attempts: 0, outcome: null, messages: [] });
    const pending = await this.rows.count({ where: { jobId: id, status: 'pending' } });
    if (!pending) throw new BadRequestException('Nothing to retry — every row was saved or skipped');
    await this.jobs.update({ id }, {
      status: 'queued', cancelRequested: false, finishedAt: null, lastError: null, lockedBy: null, heartbeatAt: null, attempts: 0, dismissedAt: null,
      caller: { userId: caller.userId, orgId: caller.orgId, isAdmin: caller.isAdmin, actions: caller.actions },
    });
    this.pipeline.audit(caller, 'recruitment.import_retried', `Retrying ${pending} rows of "${job.fileName}"`, { type: 'import', id }, { reset: reset.affected ?? 0 });
    this.kick();
    return this.view(await this.requireJob(caller.orgId, id));
  }

  async dismiss(caller: RecruitmentCaller, id: string) {
    assertCan(caller, 'view');
    const job = await this.requireJob(caller.orgId, id);
    if (job.status === 'queued' || job.status === 'processing') throw new ConflictException('A running import can’t be dismissed — cancel it first');
    await this.jobs.update({ id }, { dismissedAt: new Date() });
    return { success: true as const };
  }

  // ── worker ────────────────────────────────────────────────────────────────────

  /** Claim and run jobs until none are ready. Re-entrancy safe within this process. */
  async tick() {
    if (this.running || this.stopping) return;
    this.running = true;
    try {
      for (let guard = 0; guard < 20 && !this.stopping; guard++) {
        const jobId = await this.claim();
        if (!jobId) break;
        await this.run(jobId);
      }
    } catch (err) {
      this.logger.error(`import worker tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Atomically take the oldest ready job: queued, or processing with an expired lease.
   * Claims are serialised with a transaction-scoped advisory lock, so the
   * "one running job per organization" check can't race between instances.
   */
  private async claim(): Promise<string | null> {
    return this.dataSource.transaction(async (m) => {
      await m.query(`SELECT pg_advisory_xact_lock(hashtextextended('rec-import-claim', 0))`);
      const out: unknown = await m.query(
        `UPDATE recruitment_import_jobs j
            SET status = 'processing', locked_by = $1, heartbeat_at = now(), started_at = coalesce(j.started_at, now()),
                attempts = j.attempts + 1, updated_at = now()
          WHERE j.id = (
            SELECT c.id FROM recruitment_import_jobs c
             WHERE (c.status = 'queued' OR (c.status = 'processing' AND c.heartbeat_at < now() - make_interval(secs => $2)))
               AND NOT EXISTS (
                 SELECT 1 FROM recruitment_import_jobs o
                  WHERE o.organization_id = c.organization_id AND o.id <> c.id AND o.status = 'processing'
                    AND o.heartbeat_at >= now() - make_interval(secs => $2))
             ORDER BY c.created_at
             FOR UPDATE SKIP LOCKED
             LIMIT 1)
          RETURNING j.id`,
        [this.workerId, LEASE_SECONDS],
      );
      return returningRows<{ id: string }>(out)[0]?.id ?? null;
    });
  }

  private async run(jobId: string) {
    const job = await this.jobs.findOne({ where: { id: jobId } });
    if (!job || job.lockedBy !== this.workerId) return;
    if (job.attempts > MAX_JOB_ATTEMPTS) {
      await this.finish(job, 'failed', 'The import was interrupted too many times. Retry it to continue from the last saved row.');
      return;
    }
    try {
      const ctx = await this.importer.createContext(job.caller, job.options, false);
      await this.recoverStuckRows(job);
      await this.rehydrate(job, ctx);

      while (!this.stopping) {
        const batch = await this.rows.find({ where: { jobId, status: 'pending' }, order: { idx: 'ASC' }, take: BATCH_SIZE });
        if (!batch.length) break;
        for (const row of batch) {
          if (this.stopping) break;
          await this.rows.update({ id: row.id }, { status: 'processing', attempts: row.attempts + 1 });
          const res = await this.importer.processRow(ctx, row.payload as unknown as ImportRowDto);
          await this.rows.update({ id: row.id }, this.rowPatch(res) as any);
        }
        const state = await this.refreshCounters(jobId);
        if (!state) return; // lease lost to another worker — stop quietly
        if (state.cancelRequested) {
          await this.finish(job, 'cancelled');
          return;
        }
      }
      if (this.stopping) {
        // Shutting down (deploy/restart): release now instead of waiting for the lease to expire.
        await this.refreshCounters(jobId);
        await this.jobs.update({ id: jobId, lockedBy: this.workerId }, { status: 'queued', lockedBy: null, heartbeatAt: null, attempts: Math.max(job.attempts - 1, 0) });
        return;
      }
      await this.refreshCounters(jobId);
      await this.finish(job, 'completed');
    } catch (err: any) {
      const message = err?.message ?? String(err);
      this.logger.error(`import ${jobId} failed: ${message}`);
      if (job.attempts < MAX_JOB_ATTEMPTS) {
        // Transient (DB blip, deploy): hand it back to the queue; unfinished rows resume.
        await this.jobs.update({ id: jobId, lockedBy: this.workerId }, { status: 'queued', lockedBy: null, heartbeatAt: null, lastError: message.slice(0, 2000) });
      } else {
        await this.refreshCounters(jobId).catch(() => undefined);
        await this.finish(job, 'failed', message);
      }
    }
  }

  /** Rows left mid-flight by a crashed worker: retry them, unless they keep crashing. */
  private async recoverStuckRows(job: RecruitmentImportJobEntity) {
    await this.rows.createQueryBuilder().update()
      .set({ status: 'error', outcome: 'error', messages: () => `'["This row stopped the import repeatedly and was set aside"]'::jsonb`, processedAt: () => 'now()' })
      .where('job_id = :id AND status = :s AND attempts >= :max', { id: job.id, s: 'processing', max: MAX_ROW_ATTEMPTS })
      .execute();
    await this.rows.update({ jobId: job.id, status: 'processing' }, { status: 'pending' });
  }

  /** Rebuild in-file identity from rows already saved, so a resumed job doesn't duplicate people. */
  private async rehydrate(job: RecruitmentImportJobEntity, ctx: ImportContext) {
    const done = await this.rows.find({
      where: { jobId: job.id, status: 'done' }, order: { idx: 'ASC' },
      select: { id: true, payload: true, candidateId: true, rowNumber: true, talentPool: true, opening: true, openingCreated: true },
    });
    if (!done.length) return;
    this.importer.rehydrateContext(ctx, done.map((d) => ({ payload: d.payload as unknown as ImportRowDto, candidateId: d.candidateId, rowNumber: d.rowNumber, talentPool: d.talentPool })));
    ctx.seq = done.length;
  }

  private rowPatch(res: ImportRowResult): Partial<RecruitmentImportRowEntity> {
    const status: ImportRowStatus = res.outcome === 'error' ? 'error' : res.outcome === 'skipped' ? 'skipped' : 'done';
    return {
      status, outcome: res.outcome, candidateId: res.candidateId, fullName: res.fullName?.slice(0, 300) ?? null,
      opening: res.opening?.slice(0, 200) ?? null, lead: res.lead?.slice(0, 300) ?? null,
      appliedToOpening: res.appliedToOpening, submittedToLead: res.submittedToLead, talentPool: res.talentPool, openingCreated: res.openingCreated,
      duplicate: (res.duplicate as unknown as Record<string, unknown>) ?? null, messages: res.messages.slice(0, 20), processedAt: new Date(),
    };
  }

  /**
   * Recompute counters from the row table (exact and restart-safe) and renew the lease.
   * Returns null when this worker no longer owns the job.
   */
  private async refreshCounters(jobId: string): Promise<{ cancelRequested: boolean } | null> {
    const out: unknown = await this.dataSource.query(
      `UPDATE recruitment_import_jobs j SET
          processed_rows = s.processed, created_count = s.created, merged_count = s.merged, skipped_count = s.skipped,
          error_count = s.errors, flagged_count = s.flagged, applications_count = s.apps, submissions_count = s.subs,
          talent_pool_count = s.pool, openings_created = s.openings, heartbeat_at = now(), updated_at = now()
        FROM (
          SELECT
            count(*) FILTER (WHERE r.status IN ('done','skipped','error'))::int AS processed,
            count(*) FILTER (WHERE r.outcome = 'created')::int AS created,
            count(*) FILTER (WHERE r.outcome = 'merged')::int AS merged,
            count(*) FILTER (WHERE r.status = 'skipped')::int AS skipped,
            count(*) FILTER (WHERE r.status = 'error')::int AS errors,
            count(*) FILTER (WHERE r.duplicate->>'action' = 'flagged')::int AS flagged,
            count(*) FILTER (WHERE r.applied_to_opening)::int AS apps,
            count(*) FILTER (WHERE r.submitted_to_lead)::int AS subs,
            (SELECT count(*)::int FROM (
               SELECT p.candidate_id FROM recruitment_import_rows p
                WHERE p.job_id = $1 AND p.status = 'done' AND p.candidate_id IS NOT NULL
                GROUP BY p.candidate_id HAVING bool_and(p.talent_pool)) t) AS pool,
            coalesce((SELECT jsonb_agg(DISTINCT o.opening) FROM recruitment_import_rows o
                       WHERE o.job_id = $1 AND o.opening_created AND o.opening IS NOT NULL), '[]'::jsonb) AS openings
          FROM recruitment_import_rows r WHERE r.job_id = $1
        ) s
       WHERE j.id = $1 AND j.locked_by = $2
       RETURNING j.cancel_requested`,
      [jobId, this.workerId],
    );
    const row = returningRows<{ cancel_requested: boolean }>(out)[0];
    return row ? { cancelRequested: !!row.cancel_requested } : null;
  }

  private async finish(job: RecruitmentImportJobEntity, status: Extract<ImportJobStatus, 'completed' | 'failed' | 'cancelled'>, error?: string) {
    await this.jobs.update({ id: job.id }, {
      status, finishedAt: new Date(), lockedBy: null, heartbeatAt: null, ...(error ? { lastError: error.slice(0, 2000) } : status === 'completed' ? { lastError: null } : {}),
    });
    const fresh = await this.jobs.findOne({ where: { id: job.id } });
    if (!fresh) return;
    const caller = fresh.caller;
    const summary = `${fresh.createdCount} new · ${fresh.mergedCount} merged${fresh.errorCount ? ` · ${fresh.errorCount} need attention` : ''}`;
    this.pipeline.audit(caller, `recruitment.import_${status}`, `Import of "${fresh.fileName}" ${status}: ${summary}`, { type: 'import', id: fresh.id }, {
      totalRows: fresh.totalRows, processedRows: fresh.processedRows, created: fresh.createdCount, merged: fresh.mergedCount,
      skipped: fresh.skippedCount, errors: fresh.errorCount, flagged: fresh.flaggedCount, talentPool: fresh.talentPoolCount,
    });
    if (status !== 'cancelled') {
      this.pipeline.notify({
        organizationId: fresh.organizationId, userId: fresh.createdBy, type: RECRUITMENT_NOTIFICATIONS.IMPORT_FINISHED,
        title: status === 'completed' ? `Import finished: ${fresh.fileName}` : `Import stopped: ${fresh.fileName}`,
        body: status === 'completed' ? summary : (error ?? 'The import could not be completed'),
        data: { actionUrl: `/recruitment?import=${fresh.id}`, importId: fresh.id },
      });
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────────

  private async requireJob(orgId: string, id: string) {
    const job = await this.jobs.findOne({ where: { id, organizationId: orgId } });
    if (!job) throw new NotFoundException('Import not found');
    return job;
  }

  private assertOwnerOrEditor(caller: RecruitmentCaller, job: RecruitmentImportJobEntity, verb: string) {
    if (job.createdBy === caller.userId && can(caller, 'create')) return;
    if (can(caller, 'edit')) return;
    throw new ForbiddenException(`Only the person who started this import (or a recruitment editor) can ${verb} it`);
  }

  private async view(job: RecruitmentImportJobEntity) {
    return (await this.views([job]))[0];
  }

  private async views(jobs: RecruitmentImportJobEntity[]) {
    const names = await this.pipeline.userNames(jobs.map((j) => j.createdBy));
    const now = Date.now();
    return jobs.map((j) => {
      const elapsed = j.startedAt ? ((j.finishedAt ?? new Date(now)).getTime() - j.startedAt.getTime()) / 1000 : 0;
      const rate = elapsed > 0 ? j.processedRows / elapsed : 0;
      const remaining = Math.max(j.totalRows - j.processedRows, 0);
      const active = j.status === 'queued' || j.status === 'processing';
      return {
        id: j.id, fileName: j.fileName, fileSize: j.fileSize, sheetNames: j.sheetNames ?? [], status: j.status,
        createdBy: j.createdBy, createdByName: names.get(j.createdBy) ?? null, createdAt: j.createdAt,
        startedAt: j.startedAt, finishedAt: j.finishedAt, cancelRequested: j.cancelRequested,
        totalRows: j.totalRows, processedRows: j.processedRows,
        progressPct: j.totalRows ? Math.min(100, Math.round((j.processedRows / j.totalRows) * 100)) : 0,
        counts: {
          created: j.createdCount, merged: j.mergedCount, skipped: j.skippedCount, errors: j.errorCount, flagged: j.flaggedCount,
          applications: j.applicationsCount, submissions: j.submissionsCount, talentPool: j.talentPoolCount,
        },
        openingsCreated: j.openingsCreated ?? [],
        etaSeconds: active && rate > 0 ? Math.round(remaining / rate) : null,
        lastError: j.lastError,
        stale: j.status === 'processing' && !!j.heartbeatAt && now - j.heartbeatAt.getTime() > LEASE_SECONDS * 1000,
      };
    });
  }
}
