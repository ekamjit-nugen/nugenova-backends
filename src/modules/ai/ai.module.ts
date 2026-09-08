import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { VerticalModule } from '../vertical/vertical.module';
import { GuardianModule } from '../guardian/guardian.module';
import { UserEntity } from '../auth/entities/user.entity';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { AiUsageEventEntity } from './entities/ai-usage-event.entity';
import { AiUsageCounterEntity } from './entities/ai-usage-counter.entity';
import { AiService } from './services/ai.service';
import { AiUsageService } from './services/ai-usage.service';
import { AiController } from './ai.controller';
import { LlmProviderFactory } from './providers/llm-provider.factory';
import { AI_POLICY } from './policy/ai-policy';
import { TierConsentUsagePolicy } from './policy/tier-consent-usage-policy';
import { AiUsageRoleGuard } from './guards/ai-usage-role.guard';

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
 *   - A REAL policy ({@link TierConsentUsagePolicy}) is bound to AI_POLICY: it
 *     gates every call on the vertical-pack `aiTierCeiling`, guardian consent
 *     (when a subject is named), and a per-org usage/credit ceiling. It reads
 *     VerticalPackService + GuardianService (imported below) + AiUsageService.
 *
 * JWT-guarded, org-scoped, `req.user` only. AuthModule supplies JwtAuthGuard.
 * The usage-reporting reads (`/ai/usage/events|by-user|summary`) are further
 * gated to owner/admin/hr by {@link AiUsageRoleGuard} and enrich rows from
 * users + org_memberships (registered below, read-only).
 */
@Module({
  imports: [
    AuthModule,
    VerticalModule,
    GuardianModule,
    TypeOrmModule.forFeature([
      AiUsageEventEntity,
      AiUsageCounterEntity,
      UserEntity,
      OrgMembershipEntity,
    ]),
  ],
  controllers: [AiController],
  providers: [
    AiService,
    AiUsageService,
    LlmProviderFactory,
    AiUsageRoleGuard,
    // Real tier/consent/usage policy — replaces the legacy AllowAllAiPolicy seam.
    { provide: AI_POLICY, useClass: TierConsentUsagePolicy },
  ],
  exports: [AiService, AiUsageService],
})
export class AiModule {}
