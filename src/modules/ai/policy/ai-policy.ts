/**
 * AI policy seam — the pre-call gate for tier ceilings and consent.
 *
 * COMPLETE AI needs two checks BEFORE any org spends tokens:
 *   1. the org's AI tier ceiling (the vertical-pack `aiTierCeiling`), and
 *   2. a guardian/consent gate (`isConsented`) for regulated verticals (LMS).
 *
 * Both live on a DIFFERENT branch (`feat/lms-p0`) and cannot be imported here
 * yet. So this module defines the SEAM — an {@link AiPolicy} interface plus a
 * {@link AI_POLICY} DI token — and ships a default {@link AllowAllAiPolicy} that
 * permits everything. When `feat/lms-p0` merges, a real implementation is bound
 * to the token (in AiModule) with NO change to AiService, which already calls
 * `policy.check(...)` before every completion.
 *
 * TODO(feat/lms-p0): bind a real AiPolicy that consults aiTierCeiling +
 * guardian isConsented, and enforce per-period token/credit ceilings using
 * AiUsageService counters (see PLAYBOOK.md "Tier-ceiling / consent seam").
 */

import { AiUsageFeature } from '../entities/ai-usage-event.entity';

/** Everything a policy needs to decide, resolved from the trusted JWT + call. */
export interface AiPolicyContext {
  organizationId: string | null;
  userId: string | null;
  feature: AiUsageFeature;
  /** The model about to be used, if already resolved. */
  model?: string;
  /** Rough size hint (chars of prompt) for a policy that wants to pre-estimate. */
  approxPromptChars?: number;
  /**
   * Requested AI tier for this call (0–3). Defaults to 1 when the caller omits
   * it. Compared against the org's vertical-pack `aiTierCeiling`.
   */
  tier?: number;
  /**
   * Optional learner membership id whose data this call processes. When present,
   * the policy gates on guardian consent for the AI purpose (regulated / LMS
   * verticals). Omit for ordinary calls — the consent check is then skipped.
   */
  subjectMembershipId?: string | null;
}

/**
 * A deny carries a human-readable reason surfaced to the caller (HTTP 403).
 *
 * Deny `code`s the real policy ({@link TierConsentUsagePolicy}) can return:
 *   - `tier_ceiling`  — requested tier exceeds the org's vertical-pack ceiling.
 *   - `not_consented` — a subject was named but has no active guardian consent.
 *   - `usage_ceiling` — the org's current-period tokens/cost exceeds its cap.
 */
export interface AiPolicyDecision {
  allowed: boolean;
  reason?: string;
  /** Machine-readable code, e.g. 'tier_ceiling' | 'not_consented' | 'usage_ceiling'. */
  code?: string;
}

/** The gate AiService calls before every completion. Implementations must not throw. */
export interface AiPolicy {
  check(ctx: AiPolicyContext): Promise<AiPolicyDecision>;
}

/** DI token for the active policy. Defaults to {@link AllowAllAiPolicy}. */
export const AI_POLICY = Symbol('AI_POLICY');

/**
 * Default: allow every call. Keeps the module self-contained until the real
 * tier/consent implementation is merged from `feat/lms-p0`. Deliberately does
 * NOT read tokens/consent — it is the documented no-op that makes the seam safe.
 */
export class AllowAllAiPolicy implements AiPolicy {
  async check(_ctx: AiPolicyContext): Promise<AiPolicyDecision> {
    return { allowed: true };
  }
}
