import { Logger } from '@nestjs/common';
import {
  LlmCompleteOptions,
  LlmCompletion,
  LlmMessage,
  LlmProvider,
} from './llm-provider';
import { DEFAULT_TIMEOUT_MS } from './llm-config';

/**
 * OpenAI-compatible adapter — also the path for any OpenAI-compatible gateway
 * (Azure OpenAI, the legacy RunPod/vLLM endpoint, OpenRouter, …) by pointing
 * `OPENAI_BASE_URL` at it. Uses the Chat Completions shape, which already
 * matches our {@link LlmMessage[]} (system stays a message role), so the mapping
 * is thin. Plain `fetch`, no SDK dep. Network only in `complete()`.
 */
export class OpenAiProvider implements LlmProvider {
  readonly name: string;
  private readonly logger = new Logger(OpenAiProvider.name);

  constructor(
    readonly defaultModel: string,
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.openai.com/v1',
    // Attribution label for the usage ledger — 'openai' by default, 'runpod' when
    // this adapter is pointed at the RunPod vLLM OpenAI-compatible route.
    name = 'openai',
  ) {
    this.name = name;
  }

  async complete(messages: LlmMessage[], opts: LlmCompleteOptions = {}): Promise<LlmCompletion> {
    const model = opts.model || this.defaultModel;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // A bearer key is optional for some self-hosted OpenAI-compatible servers.
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          stream: false,
          messages,
          temperature: opts.temperature ?? 0.7,
          max_tokens: opts.maxTokens ?? 2048,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`OpenAI ${res.status}: ${body.slice(0, 300)}`);
      }

      const data: any = await res.json();
      const text = data?.choices?.[0]?.message?.content ?? '';
      const promptTokens = data?.usage?.prompt_tokens ?? 0;
      const completionTokens = data?.usage?.completion_tokens ?? 0;
      return {
        text,
        model: data?.model || model,
        provider: this.name,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: data?.usage?.total_tokens ?? promptTokens + completionTokens,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
