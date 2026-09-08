import { ConfigService } from '@nestjs/config';

/**
 * AI usage ceiling + consent configuration — the env-driven knobs the real
 * {@link TierConsentUsagePolicy} reads. Kept in ONE file so ops can tune the
 * per-org credit cap without a code change, and so the documented defaults live
 * next to the code that applies them.
 *
 * Legacy had NO usage ceiling at all (the RunPod/vLLM box was unmetered), so an
 * org could spend without bound. This module supplies the sane default the
 * PLAYBOOK TODO calls for: a per-org, per-period token cap (and an optional USD
 * cost cap), overridable globally or per tier.
 */

/**
 * Default per-org, per-period token cap when nothing is configured. A
 * deliberately generous ceiling — high enough not to surprise normal usage,
 * low enough to stop a runaway loop from spending unbounded credit. Ops tune it
 * via `AI_USAGE_TOKEN_CAP` (global) or `AI_USAGE_TOKEN_CAP_TIER_<n>` (per tier).
 */
export const DEFAULT_AI_USAGE_TOKEN_CAP = 5_000_000;

/** The guardian consent purpose an AI call gates on when a subject is named. */
export const DEFAULT_AI_CONSENT_PURPOSE = 'ai';

/** Resolved caps + purpose for one policy decision. */
export interface AiUsageLimits {
  /** Per-org/period token ceiling. `0` (or negative) disables the token gate. */
  tokenCap: number;
  /** Per-org/period USD cost ceiling. `0` disables the cost gate (the default). */
  costCapUsd: number;
  /** The guardian consent purpose to check when a subject is named. */
  consentPurpose: string;
}

function num(config: ConfigService, key: string): number | undefined {
  const raw = config.get<string>(key);
  if (raw === undefined || raw === null || String(raw).trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Resolve the usage limits for a call at `tier`. Precedence for the token cap:
 * `AI_USAGE_TOKEN_CAP_TIER_<tier>` → `AI_USAGE_TOKEN_CAP` → the built-in default.
 * The cost cap is a single global `AI_USAGE_COST_CAP_USD` (off unless set).
 */
export function resolveAiUsageLimits(
  config: ConfigService,
  tier: number,
): AiUsageLimits {
  const perTier = num(config, `AI_USAGE_TOKEN_CAP_TIER_${tier}`);
  const global = num(config, 'AI_USAGE_TOKEN_CAP');
  const tokenCap = perTier ?? global ?? DEFAULT_AI_USAGE_TOKEN_CAP;
  const costCapUsd = num(config, 'AI_USAGE_COST_CAP_USD') ?? 0;
  const consentPurpose =
    config.get<string>('AI_CONSENT_PURPOSE')?.trim() || DEFAULT_AI_CONSENT_PURPOSE;
  return { tokenCap, costCapUsd, consentPurpose };
}
