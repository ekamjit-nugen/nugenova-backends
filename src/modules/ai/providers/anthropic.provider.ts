import { Logger } from '@nestjs/common';
import {
  LlmCompleteOptions,
  LlmCompletion,
  LlmMessage,
  LlmProvider,
} from './llm-provider';
import { ANTHROPIC_API_VERSION, DEFAULT_TIMEOUT_MS } from './llm-config';

/**
 * Anthropic (Claude) adapter — the platform default.
 *
 * Talks to the Messages API (`POST /v1/messages`) over plain `fetch` (Node ≥18
 * global fetch, matching how MailService calls ZeptoMail — no axios/SDK dep in
 * this repo). Anthropic splits the system prompt out of the messages array and
 * requires `max_tokens`, so we adapt the OpenAI-style {@link LlmMessage[]} here.
 *
 * Only `complete()` touches the network, and it is never exercised by unit specs
 * (they bind a stub to the LLM_PROVIDER token). A future hardening is swapping
 * this for the official `@anthropic-ai/sdk` — see PLAYBOOK.md "Deferred".
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  private readonly logger = new Logger(AnthropicProvider.name);

  constructor(
    readonly defaultModel: string,
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.anthropic.com',
  ) {}

  async complete(messages: LlmMessage[], opts: LlmCompleteOptions = {}): Promise<LlmCompletion> {
    if (!this.apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');

    const model = opts.model || this.defaultModel;
    // Anthropic carries the system prompt out-of-band, not as a message role.
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const turns = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_API_VERSION,
        },
        body: JSON.stringify({
          model,
          max_tokens: opts.maxTokens ?? 2048,
          temperature: opts.temperature ?? 0.7,
          ...(system ? { system } : {}),
          messages: turns,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Anthropic ${res.status}: ${body.slice(0, 300)}`);
      }

      const data: any = await res.json();
      // content is an array of blocks; concatenate the text blocks.
      const text = Array.isArray(data?.content)
        ? data.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('')
        : '';
      const inputTokens = data?.usage?.input_tokens ?? 0;
      const outputTokens = data?.usage?.output_tokens ?? 0;
      return {
        text,
        model: data?.model || model,
        provider: this.name,
        usage: {
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
