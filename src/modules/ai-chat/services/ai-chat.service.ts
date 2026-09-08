import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';

import { AiService } from '../../ai/services/ai.service';
import { LlmMessage } from '../../ai/providers/llm-provider';
import { AiUsageFeature } from '../../ai/entities/ai-usage-event.entity';
import {
  KnowledgeRetrievalService,
  RetrievedChunk,
  DEFAULT_TOP_K,
} from '../../knowledge/knowledge-retrieval.service';

import { AiConversationEntity } from '../entities/ai-conversation.entity';
import { AiMessageEntity, AiMessageSource } from '../entities/ai-message.entity';
import { AiJobEntity } from '../entities/ai-job.entity';
import { AiJobService, ORPHAN_AGE_MS } from './ai-job.service';

/** Feature tag recorded on the usage ledger for every chatbot completion. */
export const CHATBOT_FEATURE: AiUsageFeature = 'chatbot';

/** Prior turns fed back to the model as context (caps prompt growth). */
export const MAX_HISTORY_MESSAGES = 12;

/** Input carried on the AiJob row for a 'chat' job. */
interface ChatJobInput {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  query: string;
}

/**
 * AiChatService — multi-turn, RAG-grounded AI chatbot conversations with
 * ASYNC answer generation.
 *
 * Isolation: every read AND write is scoped to `organizationId` AND `userId`;
 * a user only ever touches their own threads (see {@link loadOwnedConversation}).
 *
 * Send flow (mirrors the pattern the task specifies):
 *   1. persist the user message,
 *   2. create a PENDING assistant message + an AiJob,
 *   3. kick the job off (non-blocking) and RETURN immediately.
 * The background worker ({@link runChatJob}) then retrieves org chunks for the
 * latest user message, builds a grounded system block (numbered sources when
 * chunks are found, a general block otherwise — grounded-with-fallback exactly
 * like `/ai/ask`), assembles the capped conversation history + the new user
 * turn, calls {@link AiService.complete} (feature `chatbot`, so it inherits the
 * tier/consent/usage policy gate + metering), and writes the assistant message
 * (content/sources/grounded/status='done') — or flips it to 'error' on failure.
 *
 * RESTART SEAM (see PLAYBOOK): the worker runs in-process, so a restart orphans
 * any in-flight turn. {@link onModuleInit} (a) registers the 'chat' worker with
 * AiJobService and (b) reconciles assistant messages left `pending` past
 * {@link ORPHAN_AGE_MS} to `error`, so the client's poll terminates.
 */
@Injectable()
export class AiChatService implements OnModuleInit {
  private readonly logger = new Logger(AiChatService.name);

  constructor(
    @InjectRepository(AiConversationEntity)
    private readonly conversations: Repository<AiConversationEntity>,
    @InjectRepository(AiMessageEntity)
    private readonly messages: Repository<AiMessageEntity>,
    private readonly jobs: AiJobService,
    private readonly ai: AiService,
    private readonly retrieval: KnowledgeRetrievalService,
  ) {}

  onModuleInit(): void {
    // Bind the worker here so AiJobService never imports this service (no cycle).
    this.jobs.registerWorker('chat', (job) => this.runChatJob(job));
    // Reconcile messages orphaned by a restart (best-effort, never blocks boot).
    this.reapOrphanedMessages().catch((err) =>
      this.logger.error(`Orphan message reconcile failed: ${String(err)}`),
    );
  }

  // ── conversation CRUD ──────────────────────────────────────────────────────

  /** Create an empty conversation owned by the caller. */
  async createConversation(
    organizationId: string | null,
    userId: string,
    title?: string,
  ): Promise<AiConversationEntity> {
    const conv = this.conversations.create({
      organizationId,
      userId,
      title: title?.trim() || null,
      lastMessageAt: null,
    });
    return this.conversations.save(conv);
  }

  /** List the caller's own conversations, newest activity first. */
  async listConversations(organizationId: string | null, userId: string) {
    const rows = await this.conversations.find({
      where: { organizationId: organizationId ?? undefined, userId },
      order: { lastMessageAt: 'DESC', createdAt: 'DESC' },
    });
    return rows.map((c) => ({
      id: c.id,
      title: c.title,
      lastMessageAt: c.lastMessageAt,
      updatedAt: c.updatedAt,
    }));
  }

  /** Load a conversation + its ordered messages. Caller-owned only. */
  async getConversation(organizationId: string | null, userId: string, id: string) {
    const conv = await this.loadOwnedConversation(organizationId, userId, id);
    const msgs = await this.messages.find({
      where: { conversationId: conv.id },
      order: { createdAt: 'ASC' },
    });
    return {
      id: conv.id,
      title: conv.title,
      messages: msgs.map((m) => this.serializeMessage(m)),
    };
  }

  /** Hard-delete a conversation and all its messages. Caller-owned only. */
  async deleteConversation(
    organizationId: string | null,
    userId: string,
    id: string,
  ): Promise<{ deleted: true }> {
    const conv = await this.loadOwnedConversation(organizationId, userId, id);
    await this.messages.delete({ conversationId: conv.id });
    await this.conversations.delete({ id: conv.id });
    return { deleted: true };
  }

  // ── the send flow (async) ──────────────────────────────────────────────────

  /**
   * Persist the user turn, create a pending assistant turn + an AiJob, fire the
   * background worker, and return immediately — the LLM call is NOT awaited.
   */
  async sendMessage(
    organizationId: string | null,
    userId: string,
    conversationId: string,
    content: string,
  ) {
    const conv = await this.loadOwnedConversation(organizationId, userId, conversationId);
    const text = content.trim();

    const now = new Date();

    // 1. user message (complete, done immediately)
    const userMessage = await this.messages.save(
      this.messages.create({
        conversationId: conv.id,
        organizationId: conv.organizationId,
        role: 'user',
        content: text,
        status: 'done',
      }),
    );

    // 2. pending assistant placeholder — the client's poll target
    const assistantMessage = await this.messages.save(
      this.messages.create({
        conversationId: conv.id,
        organizationId: conv.organizationId,
        role: 'assistant',
        content: '',
        sources: [],
        grounded: false,
        status: 'pending',
      }),
    );

    // 3. the background job
    const job = await this.jobs.submit({
      organizationId: conv.organizationId,
      userId,
      kind: 'chat',
      input: {
        conversationId: conv.id,
        userMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id,
        query: text,
      } satisfies ChatJobInput,
    });

    // link the job back onto the assistant message
    assistantMessage.jobId = job.id;
    await this.messages.update({ id: assistantMessage.id }, { jobId: job.id });

    // bump activity + auto-title from the first user message
    const patch: Partial<AiConversationEntity> = { lastMessageAt: now };
    if (!conv.title) patch.title = this.deriveTitle(text);
    await this.conversations.update({ id: conv.id }, patch);

    return {
      userMessage: {
        id: userMessage.id,
        role: 'user' as const,
        content: userMessage.content,
        createdAt: userMessage.createdAt,
      },
      assistantMessage: {
        id: assistantMessage.id,
        role: 'assistant' as const,
        content: '',
        sources: [] as AiMessageSource[],
        grounded: false,
        status: 'pending' as const,
        jobId: job.id,
        createdAt: assistantMessage.createdAt,
      },
    };
  }

  /** Poll target — one message by id, caller-owned only. */
  async getMessage(organizationId: string | null, userId: string, messageId: string) {
    const msg = await this.messages.findOne({ where: { id: messageId } });
    if (!msg) throw new NotFoundException('Message not found');
    // Enforce ownership via the parent conversation (org + user).
    await this.loadOwnedConversation(organizationId, userId, msg.conversationId);
    return this.serializeMessage(msg);
  }

  // ── the background worker ───────────────────────────────────────────────────

  /**
   * Runs OUT of the request path (via AiJobService). Retrieves org context for
   * the latest user message, grounds a completion, and writes the assistant
   * turn. On failure the assistant message is flipped to 'error' and the error
   * is re-thrown so the job row is marked 'error' too.
   */
  private async runChatJob(job: AiJobEntity): Promise<Record<string, unknown>> {
    const input = job.input as unknown as ChatJobInput;
    const assistant = await this.messages.findOne({
      where: { id: input.assistantMessageId },
    });
    if (!assistant) {
      // Conversation/message was deleted before the worker ran — nothing to do.
      return { skipped: true };
    }

    try {
      // retrieve org docs for the latest user message
      const chunks = await this.retrieval.search(
        job.organizationId ?? '',
        input.query,
        DEFAULT_TOP_K,
      );
      const grounded = chunks.length > 0;

      // build history (capped) + the grounded system block
      const history = await this.buildHistory(input.conversationId, input.assistantMessageId);
      const llmMessages: LlmMessage[] = [
        { role: 'system', content: this.buildSystemPrompt(chunks) },
        ...history,
      ];

      const result = await this.ai.complete(
        llmMessages,
        { feature: CHATBOT_FEATURE, temperature: 0.2, maxTokens: 1024 },
        { organizationId: job.organizationId, userId: job.userId },
      );

      const sources: AiMessageSource[] = chunks.map((c) => ({
        sourceId: c.sourceId,
        sourceName: c.sourceName,
        sourceType: c.sourceType,
        chunkIndex: c.chunkIndex,
      }));

      await this.messages.update(
        { id: assistant.id },
        {
          content: result.text,
          sources,
          grounded,
          status: 'done',
          errorMessage: null,
        },
      );

      return { grounded, sourceCount: sources.length, model: result.model };
    } catch (err) {
      await this.messages.update(
        { id: assistant.id },
        {
          status: 'error',
          errorMessage: 'The assistant could not generate a response. Please try again.',
        },
      );
      throw err; // let AiJobService mark the job row 'error' too
    }
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  /** Load a conversation the caller owns, or 404. The single isolation gate. */
  private async loadOwnedConversation(
    organizationId: string | null,
    userId: string,
    id: string,
  ): Promise<AiConversationEntity> {
    const conv = await this.conversations.findOne({
      where: { id, organizationId: organizationId ?? undefined, userId },
    });
    if (!conv) throw new NotFoundException('Conversation not found');
    return conv;
  }

  /**
   * Prior turns as LLM messages, capped to the most recent
   * {@link MAX_HISTORY_MESSAGES}. Includes the new user turn (already persisted),
   * excludes the pending assistant placeholder and any errored assistant turn.
   */
  private async buildHistory(
    conversationId: string,
    excludeAssistantId: string,
  ): Promise<LlmMessage[]> {
    const rows = await this.messages.find({
      where: { conversationId, status: In(['done']) },
      order: { createdAt: 'ASC' },
    });
    const usable = rows
      .filter((m) => m.id !== excludeAssistantId && m.content.trim().length > 0)
      .slice(-MAX_HISTORY_MESSAGES);
    return usable.map((m) => ({ role: m.role, content: m.content }));
  }

  /** Numbered grounding block when chunks exist; a general block otherwise. */
  private buildSystemPrompt(chunks: RetrievedChunk[]): string {
    const base =
      'You are a helpful organization assistant in a multi-turn conversation. ' +
      'Use the numbered context passages below when they are relevant, cite the ' +
      'passages you used by their [n] marker, and take the prior conversation ' +
      'turns into account. If the context does not contain the answer, say you ' +
      'could not find it in the organization documents rather than guessing.';

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
    const sourceList = chunks.map((c, i) => `[${i + 1}] ${c.sourceName}`).join('\n');
    return `${base}\n\nContext passages:\n${passages}\n\nSources:\n${sourceList}`;
  }

  /** A short title derived from the first user message. */
  private deriveTitle(text: string): string {
    const oneLine = text.replace(/\s+/g, ' ').trim();
    return oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine;
  }

  /** The on-the-wire message shape used by GET conversation + GET message. */
  private serializeMessage(m: AiMessageEntity) {
    return {
      id: m.id,
      role: m.role,
      content: m.content,
      sources: m.sources ?? [],
      grounded: m.grounded,
      status: m.status,
      createdAt: m.createdAt,
    };
  }

  /**
   * RESTART SEAM (messages half): flip assistant messages left 'pending' past
   * the orphan age to 'error', so a client that was polling one abandoned by a
   * restart stops waiting. Paired with AiJobService.reapOrphans (jobs half).
   */
  private async reapOrphanedMessages(): Promise<number> {
    const cutoff = new Date(Date.now() - ORPHAN_AGE_MS);
    const res = await this.messages.update(
      { role: 'assistant', status: 'pending', createdAt: LessThan(cutoff) },
      {
        status: 'error',
        errorMessage: 'The assistant was interrupted by a server restart. Please try again.',
      },
    );
    const n = res.affected ?? 0;
    if (n > 0) this.logger.warn(`Reaped ${n} orphaned pending assistant message(s) on startup.`);
    return n;
  }
}
