import { Logger } from '@nestjs/common';
import {
  LlmCompleteOptions,
  LlmCompletion,
  LlmMessage,
  LlmProvider,
} from './llm-provider';
import { DEFAULT_TIMEOUT_MS } from './llm-config';

/**
 * Ollama / local adapter — a self-hosted, zero-marginal-cost path for dev or an
 * on-prem deployment. Talks to Ollama's native `POST /api/chat` (no auth), which
 * accepts our {@link LlmMessage[]} directly and returns `prompt_eval_count` /
 * `eval_count` as token usage. Base URL via `OLLAMA_BASE_URL`
 * (default http://localhost:11434). Network only in `complete()`.
 */
export class OllamaProvider implements LlmProvider {
  readonly name = 'ollama';
  private readonly logger = new Logger(OllamaProvider.name);

  constructor(
    readonly defaultModel: string,
    private readonly baseUrl = 'http://localhost:11434',
  ) {}

  async complete(messages: LlmMessage[], opts: LlmCompleteOptions = {}): Promise<LlmCompletion> {
    const model = opts.model || this.defaultModel;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          messages,
          options: {
            temperature: opts.temperature ?? 0.7,
            num_predict: opts.maxTokens ?? 2048,
          },
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Ollama ${res.status}: ${body.slice(0, 300)}`);
      }

      const data: any = await res.json();
      const text = data?.message?.content ?? '';
      const promptTokens = data?.prompt_eval_count ?? 0;
      const completionTokens = data?.eval_count ?? 0;
      return {
        text,
        model: data?.model || model,
        provider: this.name,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
