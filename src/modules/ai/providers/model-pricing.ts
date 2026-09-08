/**
 * Token → USD cost estimation for the usage ledger.
 *
 * The legacy Mongo ledger stored `costUsd: null` because the LLM was self-hosted
 * (RunPod/vLLM, tokens-only). The Postgres port defaults to Claude — a hosted,
 * per-token-priced provider — so we CAN estimate a dollar cost per call and roll
 * it up per org. This keeps that estimate in ONE table so a price change (or a
 * new model) is a one-line edit, never a migration.
 *
 * Prices are USD per 1,000,000 tokens, list price, standard (non-batch, non-
 * cached) tier. Anthropic figures are from the claude-api skill's model table
 * (cached 2026-06). OpenAI/Ollama figures are best-effort — see the flags in
 * PLAYBOOK.md. Costing is an ESTIMATE for dashboards/quotas, not billing truth;
 * the token counts remain the source of record.
 */

export interface ModelPrice {
  /** USD per 1M input (prompt) tokens. */
  inputPerMillion: number;
  /** USD per 1M output (completion) tokens. */
  outputPerMillion: number;
}

/**
 * Keyed by exact model id. Unknown models fall back to {@link FALLBACK_PRICE}
 * (a mid-range estimate) so a cost is never silently dropped — it is flagged as
 * approximate in PLAYBOOK.md instead.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  // ── Anthropic (claude-api skill table, USD/1M) ──
  'claude-opus-5': { inputPerMillion: 5, outputPerMillion: 25 },
  'claude-opus-4-8': { inputPerMillion: 5, outputPerMillion: 25 },
  'claude-sonnet-5': { inputPerMillion: 2, outputPerMillion: 10 },
  'claude-haiku-4-5': { inputPerMillion: 1, outputPerMillion: 5 },

  // ── OpenAI (best-effort, verify — see PLAYBOOK "Landmines") ──
  'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10 },
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },

  // ── Local / Ollama: no marginal token cost ──
  'llama3.1': { inputPerMillion: 0, outputPerMillion: 0 },
};

/** Used for any model id absent from {@link MODEL_PRICES}. */
export const FALLBACK_PRICE: ModelPrice = { inputPerMillion: 3, outputPerMillion: 15 };

/**
 * Estimate the USD cost of one call. Returns a number rounded to 6 dp (≈ a
 * millionth of a dollar), never NaN. A model with a zero price (local) yields 0.
 */
export function estimateCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const price = MODEL_PRICES[model] ?? FALLBACK_PRICE;
  const cost =
    (Math.max(0, promptTokens) / 1_000_000) * price.inputPerMillion +
    (Math.max(0, completionTokens) / 1_000_000) * price.outputPerMillion;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
