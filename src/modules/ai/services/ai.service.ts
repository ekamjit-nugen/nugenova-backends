import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';

import { LLM_PROVIDER, LlmCompleteOptions, LlmMessage, LlmProvider } from '../providers/llm-provider';
import { AI_POLICY, AiPolicy } from '../policy/ai-policy';
import { AiUsageContext, AiUsageService, promptFromMessages } from './ai-usage.service';
import { AiUsageFeature } from '../entities/ai-usage-event.entity';

/** Org + user attribution taken from the JWT-populated request. */
export interface AiCaller {
  organizationId?: string | null;
  userId?: string | null;
}

/** What `complete()` returns to a caller/controller. */
export interface AiCompletionResult {
  text: string;
  provider: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/**
 * The AI runtime's single entry point. Every completion:
 *   1. passes the {@link AiPolicy} gate (tier ceiling / consent — a no-op today,
 *      the real check merges from feat/lms-p0; see policy/ai-policy.ts),
 *   2. runs through the injected {@link LlmProvider} (Anthropic/OpenAI/Ollama),
 *   3. is recorded to the usage ledger (success AND error), and
 *   4. returns the text + token counts.
 *
 * The provider is behind the LLM_PROVIDER token, so specs bind a stub and no
 * live API call is ever made in a test. A vendor/transport failure is caught,
 * recorded as an `error` row, and re-surfaced as a safe generic message.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    @Inject(LLM_PROVIDER) private readonly provider: LlmProvider,
    @Inject(AI_POLICY) private readonly policy: AiPolicy,
    private readonly usage: AiUsageService,
  ) {}

  /** The default model the active provider will use when a call doesn't override it. */
  get defaultModel(): string {
    return this.provider.defaultModel;
  }

  /**
   * Run one completion with full policy + metering. `feature` is the purpose
   * recorded on the ledger. Throws ForbiddenException when the policy denies.
   */
  async complete(
    messages: LlmMessage[],
    opts: LlmCompleteOptions & { feature?: AiUsageFeature } = {},
    caller: AiCaller = {},
  ): Promise<AiCompletionResult> {
    const feature: AiUsageFeature = opts.feature ?? 'complete';
    const ctx: AiUsageContext = {
      organizationId: caller.organizationId ?? null,
      userId: caller.userId ?? null,
      feature,
    };

    // ── 1. policy gate (tier ceiling / consent seam) ──
    const decision = await this.policy.check({
      organizationId: ctx.organizationId ?? null,
      userId: ctx.userId ?? null,
      feature,
      model: opts.model || this.provider.defaultModel,
      approxPromptChars: messages.reduce((n, m) => n + (m.content?.length || 0), 0),
    });
    if (!decision.allowed) {
      throw new ForbiddenException(decision.reason || 'AI usage is not permitted for this organization.');
    }

    const prompt = promptFromMessages(messages);
    // ── 2. provider call, 3. record (success or error) ──
    try {
      const res = await this.provider.complete(messages, opts);
      await this.usage.record({
        ctx,
        provider: res.provider,
        model: res.model,
        usage: res.usage,
        status: 'success',
        prompt,
        output: res.text,
      });
      return { text: res.text, provider: res.provider, model: res.model, usage: res.usage };
    } catch (err) {
      this.logger.error(`LLM call failed (${feature}): ${err instanceof Error ? err.message : err}`);
      await this.usage.record({
        ctx,
        provider: this.provider.name,
        model: opts.model || this.provider.defaultModel,
        status: 'error',
        prompt,
      });
      throw new Error('AI service is temporarily unavailable. Please try again.');
    }
  }

  /**
   * Convenience: summarise text. A thin wrapper over {@link complete} that
   * demonstrates the feature-tagging pattern other modules follow.
   */
  async summarize(text: string, caller: AiCaller = {}, maxWords?: number): Promise<string> {
    const messages: LlmMessage[] = [
      {
        role: 'system',
        content: `Summarize concisely${maxWords ? ` in ${maxWords} words or less` : ''}. Output ONLY the summary.`,
      },
      { role: 'user', content: text },
    ];
    const res = await this.complete(messages, { feature: 'text_summarize', temperature: 0.3, maxTokens: 512 }, caller);
    return res.text.trim();
  }
}
