import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * Pre-aggregated per-org, per-period rollup — one row per (org, period).
 *
 * `period` is a `YYYY-MM` (UTC) string. Incremented on every recorded call so
 * per-org balance/dashboard reads are O(1) and never scan the event ledger (the
 * ledger stays the source of truth for drill-downs). This is the "credit
 * balance" surface §15 reads: tokens + estimated cost + request count consumed
 * in the period. A tier ceiling / credit allowance is compared against these
 * counters (that comparison itself lands with the tier seam — see PLAYBOOK.md).
 *
 * Concurrency: increments use an atomic `UPDATE ... SET x = x + :n` (see
 * AiUsageService.record), so parallel calls for one org never lose a write.
 */
@Entity('ai_usage_counters')
@Index('uq_ai_usage_counters_org_period', ['organizationId', 'period'], { unique: true })
export class AiUsageCounterEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  /** Billing period, `YYYY-MM` (UTC). */
  @Column({ type: 'varchar', length: 7 })
  period: string;

  @Column({ type: 'bigint', default: 0 })
  promptTokens: number;

  @Column({ type: 'bigint', default: 0 })
  completionTokens: number;

  @Column({ type: 'bigint', default: 0 })
  totalTokens: number;

  /** Rolled-up estimated USD cost for the period. */
  @Column({ type: 'numeric', precision: 14, scale: 6, default: 0 })
  costUsd: number;

  @Column({ type: 'int', default: 0 })
  requestCount: number;
}
