import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { AiUsageEventEntity, AiUsageFeature } from '../entities/ai-usage-event.entity';
import { AiUsageCounterEntity } from '../entities/ai-usage-counter.entity';
import { UserEntity } from '../../auth/entities/user.entity';
import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';
import { newObjectId } from '../../../bootstrap/database/object-id';
import { estimateCostUsd } from '../providers/model-pricing';
import { LlmMessage, LlmTokenUsage } from '../providers/llm-provider';
import {
  redactForStorage,
  resolvePiiRetentionConfig,
  retainUntilFrom,
} from './pii-redaction';

/** Org + user attribution + purpose for a recorded call. */
export interface AiUsageContext {
  organizationId?: string | null;
  userId?: string | null;
  feature: AiUsageFeature;
}

/** The per-org "credit balance" for a period — what §15 / dashboards read. */
export interface AiUsageBalance {
  organizationId: string;
  period: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  requestCount: number;
}

/**
 * Resolved actor for a usage row — name/email/role joined from users +
 * org_memberships so the admin dashboard shows a real person, not a raw id.
 * Fields are blank for a deleted/unknown user. Mirrors legacy `resolveActors`.
 */
export interface AiUsageActor {
  userId: string;
  name: string;
  email: string;
  role: string;
}

/** One enriched ledger row — the `AiUsageEvent` shape the admin dashboard reads. */
export interface AiUsageEventView {
  _id: string;
  organizationId: string | null;
  userId: string | null;
  user: AiUsageActor;
  feature: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number | null;
  streamed: boolean;
  status: 'success' | 'error';
  prompt: string;
  output: string;
  projectId: string | null;
  projectName: string | null;
  jobId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A page of the event ledger + its pagination envelope. */
export interface PaginatedEvents {
  data: AiUsageEventView[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

/** Per-user rollup row (biggest consumers first). */
export interface AiUsageByUser {
  userId: string;
  user: AiUsageActor;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  requestCount: number;
  lastUsedAt: string | null;
}

/** All-time org totals across the whole ledger. */
export interface AiUsageSummary {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  requestCount: number;
  userCount: number;
}

/** Filters for the paginated event ledger read. */
export interface UsageEventsQuery {
  userId?: string;
  feature?: string;
  projectId?: string;
  page?: number;
  limit?: number;
}

/**
 * Serialize an OpenAI-style messages array into the single prompt string stored
 * on the ledger. Keeps the role labels so the engineered system prompt and the
 * user input are both auditable (§09 audit-log requirement).
 */
export function promptFromMessages(messages: LlmMessage[] = []): string {
  return (messages || []).map((m) => `${m?.role || 'user'}: ${m?.content ?? ''}`).join('\n\n');
}

/**
 * AI credit metering (§15). Records every LLM call to the append-only event
 * ledger AND increments the per-org/period rollup, then serves per-org balances.
 *
 * Recording NEVER throws — usage logging must not break an AI response. Calls
 * without an organizationId are skipped (attribution is per-org).
 */
@Injectable()
export class AiUsageService {
  private readonly logger = new Logger(AiUsageService.name);

  constructor(
    @InjectRepository(AiUsageEventEntity)
    private readonly events: Repository<AiUsageEventEntity>,
    @InjectRepository(AiUsageCounterEntity)
    private readonly counters: Repository<AiUsageCounterEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    @InjectRepository(OrgMembershipEntity)
    private readonly memberships: Repository<OrgMembershipEntity>,
    private readonly config: ConfigService,
  ) {}

  /** Current billing period as `YYYY-MM` (UTC). */
  periodOf(date = new Date()): string {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  /**
   * Record one LLM call: append to the ledger + increment the monthly rollup.
   * Best-effort and non-throwing. Cost is estimated from the model + tokens.
   */
  async record(params: {
    ctx: AiUsageContext;
    provider: string;
    model: string;
    usage?: Partial<LlmTokenUsage>;
    streamed?: boolean;
    status?: 'success' | 'error';
    prompt?: string;
    output?: string;
  }): Promise<void> {
    const { ctx, provider, model, usage, streamed = false, status = 'success' } = params;
    if (!ctx.organizationId) return; // nothing to attribute usage to

    const promptTokens = usage?.promptTokens ?? 0;
    const completionTokens = usage?.completionTokens ?? 0;
    const totalTokens = usage?.totalTokens ?? promptTokens + completionTokens;
    const costUsd = estimateCostUsd(model, promptTokens, completionTokens);
    const period = this.periodOf();

    // PII retention/redaction — legacy stored full plaintext forever; default is
    // now a truncated snippet + a purge TTL (see pii-redaction.ts).
    const pii = resolvePiiRetentionConfig(this.config);

    try {
      await this.events.save(
        this.events.create({
          organizationId: ctx.organizationId,
          userId: ctx.userId || 'unknown',
          feature: ctx.feature,
          provider,
          model,
          promptTokens,
          completionTokens,
          totalTokens,
          costUsd,
          streamed,
          status,
          prompt: redactForStorage(params.prompt, pii),
          output: redactForStorage(params.output, pii),
          retainUntil: retainUntilFrom(pii),
        }),
      );

      // Atomic per-(org,period) upsert-increment so parallel calls never lose a
      // write. `id` is app-assigned; created_at/updated_at default to now().
      await this.counters.manager.query(
        `
        INSERT INTO ai_usage_counters
          (id, organization_id, period, prompt_tokens, completion_tokens, total_tokens, cost_usd, request_count)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 1)
        ON CONFLICT (organization_id, period) DO UPDATE SET
          prompt_tokens     = ai_usage_counters.prompt_tokens     + EXCLUDED.prompt_tokens,
          completion_tokens = ai_usage_counters.completion_tokens + EXCLUDED.completion_tokens,
          total_tokens      = ai_usage_counters.total_tokens      + EXCLUDED.total_tokens,
          cost_usd          = ai_usage_counters.cost_usd          + EXCLUDED.cost_usd,
          request_count     = ai_usage_counters.request_count     + 1,
          updated_at        = now()
        `,
        [newObjectId(), ctx.organizationId, period, promptTokens, completionTokens, totalTokens, costUsd],
      );
    } catch (err) {
      this.logger.error(
        `Failed to record AI usage for org ${ctx.organizationId}: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  /** The org's balance for a period (defaults to the current month). Zeros if none. */
  async getOrgBalance(organizationId: string, period?: string): Promise<AiUsageBalance> {
    const p = period || this.periodOf();
    const row = await this.counters.findOne({ where: { organizationId, period: p } });
    return {
      organizationId,
      period: p,
      promptTokens: Number(row?.promptTokens ?? 0),
      completionTokens: Number(row?.completionTokens ?? 0),
      totalTokens: Number(row?.totalTokens ?? 0),
      costUsd: Number(row?.costUsd ?? 0),
      requestCount: Number(row?.requestCount ?? 0),
    };
  }

  /** Full monthly series for an org, most recent period first. */
  async getOrgSeries(organizationId: string): Promise<AiUsageBalance[]> {
    const rows = await this.counters.find({
      where: { organizationId },
      order: { period: 'DESC' },
    });
    return rows.map((r) => ({
      organizationId,
      period: r.period,
      promptTokens: Number(r.promptTokens),
      completionTokens: Number(r.completionTokens),
      totalTokens: Number(r.totalTokens),
      costUsd: Number(r.costUsd),
      requestCount: Number(r.requestCount),
    }));
  }

  // ── Admin usage-reporting reads (owner/admin/hr) ──────────────────────────────

  /**
   * Paginated event ledger for an org, newest first, optionally filtered by user
   * or feature. Rows are enriched with the resolved actor (name/email/role). The
   * `projectId` filter is accepted for forward-compatibility but is a no-op until
   * per-project linkage lands (events carry `projectId: null` today).
   */
  async listEvents(organizationId: string, q: UsageEventsQuery = {}): Promise<PaginatedEvents> {
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 25));

    const where: Record<string, unknown> = { organizationId };
    if (q.userId) where.userId = q.userId;
    if (q.feature) where.feature = q.feature;

    const [rows, total] = await this.events.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    const actors = await this.resolveActors(
      organizationId,
      rows.map((r) => r.userId),
    );

    return {
      data: rows.map((r) => this.toEventView(r, actors)),
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  /** Per-user token rollup for an org, biggest consumers first. */
  async rollupByUser(organizationId: string): Promise<AiUsageByUser[]> {
    const rows: Array<{
      user_id: string | null;
      total_tokens: string;
      prompt_tokens: string;
      completion_tokens: string;
      request_count: string;
      last_used_at: Date | string | null;
    }> = await this.events.manager.query(
      `
      SELECT user_id,
             COALESCE(SUM(total_tokens), 0)      AS total_tokens,
             COALESCE(SUM(prompt_tokens), 0)     AS prompt_tokens,
             COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
             COUNT(*)                            AS request_count,
             MAX(created_at)                     AS last_used_at
      FROM ai_usage_events
      WHERE organization_id = $1
      GROUP BY user_id
      ORDER BY total_tokens DESC
      `,
      [organizationId],
    );

    const actors = await this.resolveActors(
      organizationId,
      rows.map((r) => r.user_id),
    );

    return rows.map((r) => {
      const userId = r.user_id || 'unknown';
      return {
        userId,
        user: actors.get(userId) ?? this.blankActor(userId),
        totalTokens: Number(r.total_tokens),
        promptTokens: Number(r.prompt_tokens),
        completionTokens: Number(r.completion_tokens),
        requestCount: Number(r.request_count),
        lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
      };
    });
  }

  /** All-time totals for an org across the whole ledger (+ distinct user count). */
  async summary(organizationId: string): Promise<AiUsageSummary> {
    const rows: Array<{
      total_tokens: string;
      prompt_tokens: string;
      completion_tokens: string;
      request_count: string;
      user_count: string;
    }> = await this.events.manager.query(
      `
      SELECT COALESCE(SUM(total_tokens), 0)      AS total_tokens,
             COALESCE(SUM(prompt_tokens), 0)     AS prompt_tokens,
             COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
             COUNT(*)                            AS request_count,
             COUNT(DISTINCT user_id)             AS user_count
      FROM ai_usage_events
      WHERE organization_id = $1
      `,
      [organizationId],
    );
    const r = rows[0] ?? ({} as (typeof rows)[number]);
    return {
      totalTokens: Number(r.total_tokens ?? 0),
      promptTokens: Number(r.prompt_tokens ?? 0),
      completionTokens: Number(r.completion_tokens ?? 0),
      requestCount: Number(r.request_count ?? 0),
      userCount: Number(r.user_count ?? 0),
    };
  }

  /**
   * Resolve actors for a set of userIds within an org — joins org_memberships
   * (role) and users (name/email), read-only. Mirrors legacy `resolveActors`.
   * Ids that are null/empty/'unknown' are dropped. Missing users get a blank
   * actor so the row still renders.
   */
  async resolveActors(
    organizationId: string,
    userIds: Array<string | null | undefined>,
  ): Promise<Map<string, AiUsageActor>> {
    const ids = [...new Set(userIds.filter((id): id is string => !!id && id !== 'unknown'))];
    const out = new Map<string, AiUsageActor>();
    if (!ids.length) return out;

    const [users, memberships] = await Promise.all([
      this.users.find({ where: { id: In(ids) } }),
      this.memberships.find({ where: { organizationId, userId: In(ids) } }),
    ]);

    const roleByUser = new Map<string, string>();
    for (const m of memberships) {
      if (m.userId && !roleByUser.has(m.userId)) roleByUser.set(m.userId, m.role || '');
    }

    for (const u of users) {
      const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
      out.set(u.id, {
        userId: u.id,
        name,
        email: u.email || '',
        role: roleByUser.get(u.id) || '',
      });
    }
    // A user that has a membership row but no user record still gets a role.
    for (const id of ids) {
      if (!out.has(id)) {
        out.set(id, { ...this.blankActor(id), role: roleByUser.get(id) || '' });
      }
    }
    return out;
  }

  /**
   * Purge PII from expired ledger rows: scrub `prompt`/`output` on any event
   * whose `retainUntil` has elapsed, keeping the metering row (tokens/cost)
   * intact. Returns the number of rows scrubbed. Safe to run on a cron.
   */
  async purgeExpiredEvents(now = new Date()): Promise<number> {
    const res = await this.events
      .createQueryBuilder()
      .update(AiUsageEventEntity)
      .set({ prompt: '', output: '', retainUntil: null })
      .where('retain_until IS NOT NULL AND retain_until <= :now', { now })
      .execute();
    return res.affected ?? 0;
  }

  private blankActor(userId: string): AiUsageActor {
    return { userId, name: '', email: '', role: '' };
  }

  private toEventView(
    r: AiUsageEventEntity,
    actors: Map<string, AiUsageActor>,
  ): AiUsageEventView {
    const userId = r.userId || 'unknown';
    return {
      _id: r.id,
      organizationId: r.organizationId,
      userId: r.userId,
      user: actors.get(userId) ?? this.blankActor(userId),
      feature: r.feature,
      model: r.model,
      promptTokens: Number(r.promptTokens),
      completionTokens: Number(r.completionTokens),
      totalTokens: Number(r.totalTokens),
      costUsd: r.costUsd === null || r.costUsd === undefined ? null : Number(r.costUsd),
      streamed: r.streamed,
      status: r.status,
      prompt: r.prompt ?? '',
      output: r.output ?? '',
      projectId: null,
      projectName: null,
      jobId: null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }
}
