import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * The feature that ran an AI call — the "purpose" dimension of the ledger. Kept
 * as a wide string union (ported from the Mongo schema) so any call site across
 * the platform can attribute usage without a schema change. Stored as plain
 * text in Postgres (no enum type) so adding a value is code-only, never a
 * migration.
 */
export type AiUsageFeature =
  // ai module (/ai/* endpoints)
  | 'complete'
  | 'chat'
  | 'chat_stream'
  | 'text_improve'
  | 'text_summarize'
  // other modules that meter through AiUsageService
  | 'chat_summary'
  | 'chat_smart_replies'
  | 'chat_translate'
  | 'chatbot_chat'
  | 'onboarding_structure'
  | 'project_plan'
  // knowledge module (/ai/ask — org document RAG)
  | 'org_qa'
  // ai-chat module (/ai/chat/* — async RAG-grounded chatbot conversations)
  | 'chatbot'
  // catch-all for a caller that did not name a feature
  | 'other';

/**
 * Append-only ledger: one row per LLM call.
 *
 * Postgres port of the Mongo `ai_usage_events` collection. Keeps every dimension
 * we might later slice or authorize on (org, user, provider, model, tokens,
 * cost, purpose, time). Unlike the Mongo original, `costUsd` is populated: the
 * default provider (Claude) is hosted + per-token-priced, so we estimate a
 * dollar cost per call (see model-pricing.ts). Visibility/access is a read-time
 * decision, NOT modelled here.
 *
 * `prompt`/`output` capture the full input+response for the §09 audit-log
 * requirement; they are nullable text and may be blank when a caller opts out.
 */
@Entity('ai_usage_events')
@Index('ix_ai_usage_events_org_created', ['organizationId', 'createdAt'])
@Index('ix_ai_usage_events_org_user', ['organizationId', 'userId'])
@Index('ix_ai_usage_events_org_feature', ['organizationId', 'feature'])
export class AiUsageEventEntity extends PgBaseEntity {
  /** Owning org — the tenant boundary. Always set from req.user on record. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  organizationId: string | null;

  /** Who ran it. 'unknown' when a call had no authenticated user. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  userId: string | null;

  /** The purpose/feature that ran the call. */
  @Column({ type: 'varchar', default: 'other' })
  feature: AiUsageFeature;

  /** Adapter id that served it: anthropic | openai | ollama. */
  @Column({ type: 'varchar', default: 'anthropic' })
  provider: string;

  /** The model id that actually served the request. */
  @Column({ type: 'varchar' })
  model: string;

  @Column({ type: 'int', default: 0 })
  promptTokens: number;

  @Column({ type: 'int', default: 0 })
  completionTokens: number;

  @Column({ type: 'int', default: 0 })
  totalTokens: number;

  /**
   * Estimated USD cost of the call (numeric, 6 dp). An ESTIMATE for dashboards /
   * quotas from model-pricing.ts — the token counts remain the source of truth.
   */
  @Column({ type: 'numeric', precision: 12, scale: 6, default: 0 })
  costUsd: number;

  /** True if the call was streamed (reserved — streaming is deferred). */
  @Column({ type: 'boolean', default: false })
  streamed: boolean;

  @Column({ type: 'varchar', default: 'success' })
  status: 'success' | 'error';

  /**
   * Stored input sent to the model (system+user serialised). Subject to the
   * retention/redaction policy (see AiUsageService + AI_PROMPT_STORAGE): by
   * default TRUNCATED, not the full plaintext legacy stored forever. '' when
   * storage is disabled or not captured.
   */
  @Column({ type: 'text', nullable: true, default: null })
  prompt: string | null;

  /** Stored text the model generated — same retention/redaction as `prompt`. */
  @Column({ type: 'text', nullable: true, default: null })
  output: string | null;

  /**
   * PII TTL — after this instant the row's prompt/output may be purged
   * (AiUsageService.purgeExpiredEvents). Set from `AI_PROMPT_RETENTION_DAYS` at
   * write time; `null` means "retain indefinitely" (retention disabled).
   */
  @Column({ type: 'timestamptz', nullable: true, default: null })
  retainUntil: Date | null;
}
