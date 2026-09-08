import { ConfigService } from '@nestjs/config';
import { ProviderName } from './llm-provider';

/**
 * Env-driven provider/model configuration — the single source of truth for
 * "which vendor and which model" resolved once at module-wire time.
 *
 * This is an Anthropic-friendly shop, so the default provider is Claude and the
 * default model is a current Claude id. Everything is env-overridable so ops can
 * swap vendor or downgrade to a cheaper model (cost) without a code change.
 *
 * Model-id note: the default Claude ids below are the current generation per the
 * bundled claude-api reference (Opus/Sonnet/Haiku, cached 2026-06). They are
 * named constants precisely so a future id bump is a one-line edit here — see
 * PLAYBOOK.md "Landmines". OpenAI/Ollama defaults are best-effort and flagged.
 */

/**
 * Default Anthropic model. `claude-sonnet-5` is the balanced current default for
 * high-volume org AI features (chat, summarise, drafting) — strong quality at
 * ~1/2 the token price of Opus. Ops can set AI_MODEL=claude-opus-5 for the most
 * capable current model, or claude-haiku-4-5 for the cheapest. All are current
 * ids from the claude-api reference; bump here when a newer id ships.
 */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5';

/** Default OpenAI model. Best-effort id — verify against OpenAI's current list. */
export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';

/** Default local (Ollama) model tag. */
export const DEFAULT_OLLAMA_MODEL = 'llama3.1';

/**
 * Default RunPod (Serverless vLLM, OpenAI-compatible) endpoint + model — the
 * legacy production `common/llm` values, confirmed active. RunPod is the DEFAULT
 * provider (legacy `CHATBOT_LLM_PROVIDER=runpod`). We call the OpenAI-compatible
 * route `https://api.runpod.ai/v2/<id>/openai/v1/chat/completions` (what legacy
 * production used and parsed), NOT the generic `/runsync` job API. Endpoint id
 * from `RUNPOD_AI_ENDPOINT_ID`, model from `RUNPOD_AI_MODEL`, key from
 * `RUNPOD_API_KEY`/`LLM_API_KEY`. Self-hosted → usage cost recorded 0.
 */
export const DEFAULT_RUNPOD_MODEL = 'qwen/qwen2.5-7b-instruct';
export const DEFAULT_RUNPOD_ENDPOINT_ID = 'r7q754t01akevf';

/** Anthropic Messages API version pinned on every request. */
export const ANTHROPIC_API_VERSION = '2023-06-01';

/** Default per-call HTTP timeout (ms). */
export const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Which adapter to wire, from `AI_PROVIDER` (falls back to the legacy
 * `CHATBOT_LLM_PROVIDER`). Anything unrecognised → 'anthropic'.
 */
export function selectProviderName(config: ConfigService): ProviderName {
  const raw = (
    config.get<string>('AI_PROVIDER') ||
    config.get<string>('CHATBOT_LLM_PROVIDER') ||
    'runpod' // production default (self-hosted RunPod vLLM)
  )
    .trim()
    .toLowerCase();
  if (raw === 'openai') return 'openai';
  if (raw === 'ollama' || raw === 'local') return 'ollama';
  if (raw === 'anthropic' || raw === 'claude') return 'anthropic';
  return 'runpod';
}

/** The configured default model for a provider (env `AI_MODEL` wins if set). */
export function resolveDefaultModel(config: ConfigService, provider: ProviderName): string {
  const override = config.get<string>('AI_MODEL');
  if (override && override.trim()) return override.trim();
  switch (provider) {
    case 'openai':
      return config.get<string>('OPENAI_MODEL')?.trim() || DEFAULT_OPENAI_MODEL;
    case 'ollama':
      return config.get<string>('OLLAMA_MODEL')?.trim() || DEFAULT_OLLAMA_MODEL;
    case 'runpod':
      return (
        config.get<string>('RUNPOD_AI_MODEL')?.trim() || DEFAULT_RUNPOD_MODEL
      );
    case 'anthropic':
      return config.get<string>('ANTHROPIC_MODEL')?.trim() || DEFAULT_ANTHROPIC_MODEL;
    default:
      return config.get<string>('RUNPOD_AI_MODEL')?.trim() || DEFAULT_RUNPOD_MODEL;
  }
}
