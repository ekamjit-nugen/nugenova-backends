import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { VerticalPackService } from '../../vertical/vertical-pack.service';
import { GuardianService } from '../../guardian/guardian.service';
import { AiUsageService } from '../services/ai-usage.service';
import { AiPolicy, AiPolicyContext, AiPolicyDecision } from './ai-policy';
import { resolveAiUsageLimits } from './ai-usage-limits';

/**
 * The real AI policy — replaces {@link AllowAllAiPolicy}. Runs three gates
 * before any org spends a token, in order, first deny wins:
 *
 *   1. **Tier ceiling** — the requested `tier` (default 1) must be ≤ the org's
 *      vertical-pack `aiTierCeiling` (VerticalPackService). Deny `tier_ceiling`.
 *   2. **Consent** — when a `subjectMembershipId` is named (regulated/education
 *      verticals), an ACTIVE guardian consent must exist for the AI purpose
 *      (GuardianService.isConsented). Deny `not_consented`. No subject → skip.
 *   3. **Usage ceiling** — the org's current-period counter must be under the
 *      configured token (and optional USD) cap (AiUsageService + env). Deny
 *      `usage_ceiling`. This is the ceiling legacy never had.
 *
 * Contract: **never throws.** A deny is returned as `{allowed:false, reason,
 * code}`; an UNEXPECTED infra error (vertical/guardian/DB blip) is caught,
 * logged, and treated as fail-OPEN (`allowed:true`) so a transient dependency
 * outage degrades to "unmetered gate", not "all AI down". The explicit denies
 * above always take precedence over that fallback.
 */
@Injectable()
export class TierConsentUsagePolicy implements AiPolicy {
  private readonly logger = new Logger(TierConsentUsagePolicy.name);

  constructor(
    private readonly verticals: VerticalPackService,
    private readonly guardian: GuardianService,
    private readonly usage: AiUsageService,
    private readonly config: ConfigService,
  ) {}

  async check(ctx: AiPolicyContext): Promise<AiPolicyDecision> {
    const orgId = ctx.organizationId ?? null;
    // No org context → nothing to meter or scope a ceiling to. AiUsageService
    // already skips recording org-less calls; the gate follows suit and allows.
    if (!orgId) return { allowed: true };

    const requestedTier = Number.isFinite(ctx.tier as number) ? Number(ctx.tier) : 1;
    const limits = resolveAiUsageLimits(this.config, requestedTier);

    // ── 1. tier ceiling ──
    try {
      const ceiling = await this.verticals.aiTierCeiling(orgId);
      if (requestedTier > ceiling) {
        return {
          allowed: false,
          code: 'tier_ceiling',
          reason: `Requested AI tier ${requestedTier} exceeds this organization's ceiling of ${ceiling}.`,
        };
      }
    } catch (err) {
      this.logger.warn(
        `tier ceiling check failed for org ${orgId} (allowing): ${msg(err)}`,
      );
    }

    // ── 2. consent gate (only when a subject is named) ──
    if (ctx.subjectMembershipId) {
      try {
        const consented = await this.guardian.isConsented(
          orgId,
          ctx.subjectMembershipId,
          limits.consentPurpose,
        );
        if (!consented) {
          return {
            allowed: false,
            code: 'not_consented',
            reason: `No active consent for AI processing of subject ${ctx.subjectMembershipId}.`,
          };
        }
      } catch (err) {
        // A consent lookup failure is fail-CLOSED for the named subject: a
        // regulated call must not proceed on an unverifiable consent state.
        this.logger.warn(
          `consent check failed for subject ${ctx.subjectMembershipId} (denying): ${msg(err)}`,
        );
        return {
          allowed: false,
          code: 'not_consented',
          reason: 'Consent could not be verified for the named subject.',
        };
      }
    }

    // ── 3. usage / credit ceiling ──
    try {
      if (limits.tokenCap > 0 || limits.costCapUsd > 0) {
        const balance = await this.usage.getOrgBalance(orgId);
        if (limits.tokenCap > 0 && balance.totalTokens >= limits.tokenCap) {
          return {
            allowed: false,
            code: 'usage_ceiling',
            reason: `Organization has reached its AI token cap (${limits.tokenCap}) for ${balance.period}.`,
          };
        }
        if (limits.costCapUsd > 0 && balance.costUsd >= limits.costCapUsd) {
          return {
            allowed: false,
            code: 'usage_ceiling',
            reason: `Organization has reached its AI cost cap ($${limits.costCapUsd}) for ${balance.period}.`,
          };
        }
      }
    } catch (err) {
      this.logger.warn(
        `usage ceiling check failed for org ${orgId} (allowing): ${msg(err)}`,
      );
    }

    return { allowed: true };
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
