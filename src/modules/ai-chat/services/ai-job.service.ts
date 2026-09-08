import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';

import { AiJobEntity, AiJobKind } from '../entities/ai-job.entity';

/** A worker fn for a job kind. Returns the jsonb result, or void for none. */
export type AiJobWorker = (
  job: AiJobEntity,
) => Promise<Record<string, unknown> | void>;

/** A queued/running row older than this at module init is treated as orphaned. */
export const ORPHAN_AGE_MS = 10 * 60 * 1000;

/**
 * AiJobService — DB-backed background jobs with IN-PROCESS execution.
 *
 * There is no Redis/BullMQ in this platform, so a "job" is an {@link AiJobEntity}
 * row plus a function that runs on the SAME node, kicked off with `setImmediate`
 * so it executes AFTER the HTTP response has been sent and is NEVER awaited in
 * the request path. This is what keeps a ~90s RunPod cold-start from blocking
 * the client: `submit()` persists a `queued` row and returns immediately; the
 * worker later moves it `running → done|error`.
 *
 * Workers are registered by kind (AiChatService registers 'chat' on its own
 * init), so this service never imports a consumer — no circular DI.
 *
 * RESTART SEAM (documented in PLAYBOOK): in-process execution means a
 * crash/restart abandons any `queued`/`running` row — no worker survives to
 * finish it. {@link onModuleInit} sweeps rows older than {@link ORPHAN_AGE_MS}
 * still in those states to `error('interrupted')`. The age guard avoids racing a
 * job that another (already-running) process legitimately has in flight; a
 * multi-node deployment would replace this whole mechanism with a real broker.
 */
@Injectable()
export class AiJobService implements OnModuleInit {
  private readonly logger = new Logger(AiJobService.name);
  private readonly workers = new Map<AiJobKind, AiJobWorker>();

  constructor(
    @InjectRepository(AiJobEntity)
    private readonly jobs: Repository<AiJobEntity>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reapOrphans();
  }

  /** Bind the worker that executes a given job kind. Call once, at consumer init. */
  registerWorker(kind: AiJobKind, worker: AiJobWorker): void {
    this.workers.set(kind, worker);
  }

  /**
   * Create a `queued` job and kick off its execution without awaiting it. The
   * returned row (with its id) is what the caller hands the client to poll.
   */
  async submit(params: {
    organizationId: string | null;
    userId: string;
    kind: AiJobKind;
    input: Record<string, unknown>;
  }): Promise<AiJobEntity> {
    const job = this.jobs.create({
      organizationId: params.organizationId,
      userId: params.userId,
      kind: params.kind,
      input: params.input,
      status: 'queued',
    });
    const saved = await this.jobs.save(job);
    this.kick(saved.id);
    return saved;
  }

  /**
   * Schedule the worker to run after the current request unwinds. `setImmediate`
   * (not `await`) is the whole point — the request returns now; the LLM call
   * happens later. Any thrown error is contained here: it can NEVER surface into
   * the HTTP response, only into the job/message row the worker updates.
   */
  private kick(jobId: string): void {
    setImmediate(() => {
      this.run(jobId).catch((err) => {
        // run() already records failures on the row; this is the last-ditch net.
        this.logger.error(
          `AiJob ${jobId} crashed outside its handler: ${err instanceof Error ? err.message : err}`,
        );
      });
    });
  }

  /** Execute one queued job: running → worker → done|error. Never throws. */
  private async run(jobId: string): Promise<void> {
    const job = await this.jobs.findOne({ where: { id: jobId } });
    if (!job) return;
    if (job.status !== 'queued') return; // already picked up / terminal — no double-run

    const worker = this.workers.get(job.kind);
    if (!worker) {
      await this.markError(job.id, `No worker registered for kind '${job.kind}'`);
      return;
    }

    await this.jobs.update({ id: job.id }, { status: 'running' });
    try {
      const result = await worker(job);
      await this.jobs.update(
        { id: job.id },
        // jsonb column — cast past TypeORM's DeepPartial index-signature check.
        { status: 'done', result: (result ?? {}) as object, completedAt: new Date() },
      );
    } catch (err) {
      this.logger.error(
        `AiJob ${job.id} (${job.kind}) failed: ${err instanceof Error ? err.message : err}`,
      );
      await this.markError(job.id, 'AI job failed to complete.');
    }
  }

  private async markError(jobId: string, message: string): Promise<void> {
    await this.jobs.update(
      { id: jobId },
      { status: 'error', errorMessage: message, completedAt: new Date() },
    );
  }

  /**
   * Orphan sweep — see the RESTART SEAM note on the class. Marks stale
   * queued/running rows as errored so nothing polls them forever. Returns the
   * count reaped (surfaced for logging/tests).
   */
  async reapOrphans(): Promise<number> {
    const cutoff = new Date(Date.now() - ORPHAN_AGE_MS);
    const stale = await this.jobs.find({
      where: [
        { status: 'queued', createdAt: LessThan(cutoff) },
        { status: 'running', createdAt: LessThan(cutoff) },
      ],
    });
    if (!stale.length) return 0;
    for (const job of stale) {
      await this.markError(job.id, 'Job interrupted by a server restart.');
    }
    this.logger.warn(`Reaped ${stale.length} orphaned AI job(s) on startup.`);
    return stale.length;
  }
}
