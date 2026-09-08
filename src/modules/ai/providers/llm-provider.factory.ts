import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { LLM_PROVIDER, LlmProvider } from './llm-provider';
import { AnthropicProvider } from './anthropic.provider';
import { OpenAiProvider } from './openai.provider';
import { OllamaProvider } from './ollama.provider';
import {
  resolveDefaultModel,
  selectProviderName,
  DEFAULT_RUNPOD_ENDPOINT_ID,
} from './llm-config';

/**
 * Builds the one live {@link LlmProvider} from env and binds it to the
 * {@link LLM_PROVIDER} token. Selection is `AI_PROVIDER` (default anthropic);
 * the model + key come from env with per-vendor fallbacks. Nothing above the
 * token is aware of which adapter this returned — swapping vendor is env-only.
 */
export function buildLlmProvider(config: ConfigService): LlmProvider {
  const logger = new Logger('LlmProviderFactory');
  const provider = selectProviderName(config);
  const model = resolveDefaultModel(config, provider);

  logger.log(`AI provider = ${provider}, default model = ${model}`);

  switch (provider) {
    case 'openai':
      return new OpenAiProvider(
        model,
        config.get<string>('OPENAI_API_KEY') || config.get<string>('LLM_API_KEY') || '',
        config.get<string>('OPENAI_BASE_URL') || undefined,
      );
    case 'ollama':
      return new OllamaProvider(model, config.get<string>('OLLAMA_BASE_URL') || undefined);
    case 'anthropic':
      return new AnthropicProvider(
        model,
        config.get<string>('ANTHROPIC_API_KEY') || '',
        config.get<string>('ANTHROPIC_BASE_URL') || undefined,
      );
    case 'runpod':
    default: {
      // RunPod Serverless vLLM exposes an OpenAI-compatible route, so reuse the
      // OpenAI adapter pointed at the endpoint's /openai/v1. Key = RUNPOD_API_KEY.
      const endpointId =
        config.get<string>('RUNPOD_AI_ENDPOINT_ID')?.trim() || DEFAULT_RUNPOD_ENDPOINT_ID;
      const baseUrl =
        config.get<string>('RUNPOD_BASE_URL')?.trim() ||
        `https://api.runpod.ai/v2/${endpointId}/openai/v1`;
      return new OpenAiProvider(
        model,
        config.get<string>('RUNPOD_API_KEY') || config.get<string>('LLM_API_KEY') || '',
        baseUrl,
        'runpod',
      );
    }
  }
}

/** Nest provider entry: `LLM_PROVIDER` ← the env-selected adapter. */
export const LlmProviderFactory: Provider = {
  provide: LLM_PROVIDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => buildLlmProvider(config),
};
