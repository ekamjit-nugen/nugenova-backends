import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AiUsageEventEntity, AiUsageFeature } from '../entities/ai-usage-event.entity';
import { AiUsageCounterEntity } from '../entities/ai-usage-counter.entity';
import { newObjectId } from '../../../bootstrap/database/object-id';
import { estimateCostUsd } from '../providers/model-pricing';
import { LlmMessage, LlmTokenUsage } from '../providers/llm-provider';

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
          prompt: params.prompt ?? '',
          output: params.output ?? '',
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
}
