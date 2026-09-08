/**
 * Provider abstraction for the AI runtime.
 *
 * Every LLM call in the platform goes through an {@link LlmProvider}. The
 * concrete adapter (Anthropic / OpenAI / Ollama) is chosen by env at module-wire
 * time and injected under the {@link LLM_PROVIDER} token, so:
 *   - call sites (AiService) never know or care which vendor is live;
 *   - specs bind a fake provider to the token and assert on it without ever
 *     touching the network (see ai.service.spec.ts). NO real API calls in tests.
 *
 * The interface is deliberately tiny — a single `complete()` that maps a
 * role/content message array to text + normalised token usage. Streaming, tool
 * use and vision are intentionally out of scope for this first port (see
 * PLAYBOOK.md "Deferred").
 */

/** OpenAI-style chat message. The three roles every adapter understands. */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Per-call knobs. `model` overrides the provider's configured default. */
export interface LlmCompleteOptions {
  temperature?: number;
  maxTokens?: number;
  /** Override the provider default model for this one call. */
  model?: string;
  /** Abort the underlying HTTP call after this many ms (adapter default otherwise). */
  timeoutMs?: number;
}

/**
 * Normalised token usage. Every adapter maps its vendor's usage shape onto
 * these three fields so the metering ledger is vendor-independent. Zero when the
 * vendor did not report usage (surfaces a misbehaving endpoint rather than
 * silently dropping the call from the ledger).
 */
export interface LlmTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** The result of one completion: the text plus who/what produced it. */
export interface LlmCompletion {
  text: string;
  /** The model id that actually served the request (echoed for the ledger). */
  model: string;
  /** Which adapter served it: 'anthropic' | 'openai' | 'ollama'. */
  provider: string;
  usage: LlmTokenUsage;
}

/**
 * The one seam every LLM call passes through. Implementations own the vendor
 * HTTP shape, auth, and usage-mapping; nothing above this interface does.
 */
export interface LlmProvider {
  /** Stable adapter id recorded on every usage event. */
  readonly name: string;
  /** Model used when a call does not override it — recorded and surfaced. */
  readonly defaultModel: string;
  /**
   * Run a single completion. MUST throw on transport/vendor failure (the caller
   * — AiService — catches, records an `error` usage row, and returns a safe
   * message). MUST NOT be called from unit specs against a live endpoint.
   */
  complete(messages: LlmMessage[], opts?: LlmCompleteOptions): Promise<LlmCompletion>;
}

/**
 * DI token for the active provider. AiModule binds exactly one concrete adapter
 * here (chosen by {@link selectProviderName}); specs override it with a stub.
 */
export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

/** Adapter ids understood by the factory / env selector. */
export type ProviderName = 'anthropic' | 'openai' | 'ollama';
