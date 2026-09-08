import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { AiUsageEventEntity } from './entities/ai-usage-event.entity';
import { AiUsageCounterEntity } from './entities/ai-usage-counter.entity';
import { AiService } from './services/ai.service';
import { AiUsageService } from './services/ai-usage.service';
import { AiController } from './ai.controller';
import { LlmProviderFactory } from './providers/llm-provider.factory';
import { AI_POLICY, AllowAllAiPolicy } from './policy/ai-policy';

/**
 * AI runtime — LLM provider abstraction + AI-credit metering (§15).
 *
 * Ported from the legacy Mongo `ai` module. What changed for the Postgres
 * target:
 *   - The RunPod/vLLM-only HTTP helper became a pluggable {@link LlmProvider}
 *     (Anthropic default, OpenAI, Ollama) bound to the LLM_PROVIDER token by
 *     env — see providers/. Real network calls live only inside the adapters, so
 *     specs mock the token and never hit the wire.
 *   - The Mongoose usage schemas became TypeORM entities on Postgres, with an
 *     estimated USD cost per call (hosted Claude is per-token-priced).
 *   - A tier-ceiling / consent seam (AI_POLICY) gates every call; the default
 *     allows everything until feat/lms-p0's aiTierCeiling + guardian consent
 *     merge and a real policy is bound here.
 *
 * JWT-guarded, org-scoped, `req.user` only. AuthModule supplies JwtAuthGuard.
 */
@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([AiUsageEventEntity, AiUsageCounterEntity]),
  ],
  controllers: [AiController],
  providers: [
    AiService,
    AiUsageService,
    LlmProviderFactory,
    // Default policy: allow all. Replace with a real tier/consent policy once
    // feat/lms-p0 merges — bind it to AI_POLICY here (no AiService change).
    { provide: AI_POLICY, useClass: AllowAllAiPolicy },
  ],
  exports: [AiService, AiUsageService],
})
export class AiModule {}
