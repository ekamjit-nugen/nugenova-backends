import { Injectable } from '@nestjs/common';

import { AiService, AiCaller } from '../ai/services/ai.service';
import { LlmMessage } from '../ai/providers/llm-provider';
import { AiUsageFeature } from '../ai/entities/ai-usage-event.entity';
import { KnowledgeRetrievalService, RetrievedChunk, DEFAULT_TOP_K } from './knowledge-retrieval.service';

/** A cited source on an answer. */
export interface AnswerSource {
  sourceId: string;
  sourceName: string;
  chunkIndex: number;
}

/** The org-QA answer envelope. */
export interface AskResult {
  answer: string;
  sources: AnswerSource[];
  /** False when no chunk matched — the model answered without grounding. */
  grounded: boolean;
}

/** Feature tag recorded on the usage ledger for every org-QA completion. */
export const ORG_QA_FEATURE: AiUsageFeature = 'org_qa';

/**
 * Retrieval-augmented org QA. Retrieves the top-K org-scoped chunks, assembles a
 * grounded context block + numbered source list, and runs the completion through
 * {@link AiService.complete} with the `org_qa` feature — so it inherits the full
 * tier/consent/usage policy gate AND the metering the rest of the AI runtime has.
 * It NEVER calls a provider directly.
 */
@Injectable()
export class KnowledgeQaService {
  constructor(
    private readonly retrieval: KnowledgeRetrievalService,
    private readonly ai: AiService,
  ) {}

  async ask(
    organizationId: string,
    question: string,
    caller: AiCaller,
    topK = DEFAULT_TOP_K,
  ): Promise<AskResult> {
    const q = (question || '').trim();
    const chunks = await this.retrieval.search(organizationId, q, topK);
    const grounded = chunks.length > 0;

    const messages: LlmMessage[] = [
      { role: 'system', content: this.buildSystemPrompt(chunks) },
      { role: 'user', content: q },
    ];

    const result = await this.ai.complete(
      messages,
      { feature: ORG_QA_FEATURE, temperature: 0.2, maxTokens: 1024 },
      caller,
    );

    return {
      answer: result.text,
      sources: chunks.map((c) => ({
        sourceId: c.sourceId,
        sourceName: c.sourceName,
        chunkIndex: c.chunkIndex,
      })),
      grounded,
    };
  }

  /** Assemble the grounding context block + numbered source list into a system prompt. */
  private buildSystemPrompt(chunks: RetrievedChunk[]): string {
    const base =
      'You are an organization knowledge assistant. Answer the question using ONLY ' +
      'the numbered context passages below when they are relevant, and cite the ' +
      'passages you used by their [n] marker. If the context does not contain the ' +
      'answer, say you could not find it in the organization documents rather than guessing.';

    if (chunks.length === 0) {
      return (
        base +
        '\n\nNo relevant organization documents were found for this question. ' +
        'Answer from general knowledge and make clear the answer is NOT grounded in org documents.'
      );
    }

    const passages = chunks
      .map((c, i) => `[${i + 1}] (${c.sourceName}, chunk ${c.chunkIndex})\n${c.content}`)
      .join('\n\n');

    const sourceList = chunks
      .map((c, i) => `[${i + 1}] ${c.sourceName}`)
      .join('\n');

    return `${base}\n\nContext passages:\n${passages}\n\nSources:\n${sourceList}`;
  }
}
