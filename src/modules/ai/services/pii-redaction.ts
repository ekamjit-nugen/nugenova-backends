import { ConfigService } from '@nestjs/config';

/**
 * PII retention / redaction for the AI usage ledger.
 *
 * Legacy stored the FULL prompt + output in plaintext, forever. That is a
 * standing PII liability (every learner/employee input the model ever saw). This
 * module makes storage a privacy-preserving CHOICE, defaulting to redacted:
 *
 *   - `AI_PROMPT_STORAGE=redacted` (DEFAULT) — store a truncated snippet only.
 *   - `AI_PROMPT_STORAGE=none`               — store nothing (''), keep counts.
 *   - `AI_PROMPT_STORAGE=full`               — opt back in to full plaintext.
 *
 * and stamps a TTL (`retainUntil`) from `AI_PROMPT_RETENTION_DAYS` so stored
 * text can be purged after a window (0 = keep indefinitely).
 */

export type PromptStorageMode = 'redacted' | 'none' | 'full';

/** Default truncation length for the `redacted` mode. */
export const DEFAULT_AI_PROMPT_MAX_CHARS = 500;

/** Default PII retention window (days) applied to stored prompt/output. */
export const DEFAULT_AI_PROMPT_RETENTION_DAYS = 30;

export interface PiiRetentionConfig {
  mode: PromptStorageMode;
  maxChars: number;
  retentionDays: number;
}

export function resolvePiiRetentionConfig(config: ConfigService): PiiRetentionConfig {
  const rawMode = (config.get<string>('AI_PROMPT_STORAGE') || 'redacted')
    .trim()
    .toLowerCase();
  const mode: PromptStorageMode =
    rawMode === 'full' ? 'full' : rawMode === 'none' ? 'none' : 'redacted';

  const maxCharsRaw = Number(config.get<string>('AI_PROMPT_MAX_CHARS'));
  const maxChars =
    Number.isFinite(maxCharsRaw) && maxCharsRaw > 0
      ? Math.floor(maxCharsRaw)
      : DEFAULT_AI_PROMPT_MAX_CHARS;

  const daysRaw = Number(config.get<string>('AI_PROMPT_RETENTION_DAYS'));
  const retentionDays =
    Number.isFinite(daysRaw) && daysRaw >= 0
      ? Math.floor(daysRaw)
      : DEFAULT_AI_PROMPT_RETENTION_DAYS;

  return { mode, maxChars, retentionDays };
}

/**
 * Apply the storage mode to one text field. `redacted` truncates to `maxChars`
 * and appends a marker noting how many characters were dropped, so the ledger
 * keeps an auditable snippet without hoarding the entire input.
 */
export function redactForStorage(
  text: string | undefined | null,
  cfg: PiiRetentionConfig,
): string {
  const s = text ?? '';
  if (cfg.mode === 'none') return '';
  if (cfg.mode === 'full') return s;
  if (s.length <= cfg.maxChars) return s;
  const dropped = s.length - cfg.maxChars;
  return `${s.slice(0, cfg.maxChars)}… [redacted: +${dropped} chars]`;
}

/** The `retainUntil` instant for a row written now, or null if retention is off. */
export function retainUntilFrom(cfg: PiiRetentionConfig, now = new Date()): Date | null {
  if (!cfg.retentionDays || cfg.retentionDays <= 0) return null;
  return new Date(now.getTime() + cfg.retentionDays * 24 * 60 * 60 * 1000);
}
