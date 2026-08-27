import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * PolicyVersion — an immutable snapshot captured on every content-changing edit
 * of a policy, so the full history is auditable (who changed what, when). The
 * live `policies` row is always the latest; each prior version lands here.
 *
 * `snapshot` is the full policy JSON as it was BEFORE the edit that superseded
 * it. Ordered by (policyId, version).
 */
@Entity('policy_versions')
@Index('ix_policy_version_policy', ['policyId', 'version'])
@Index('ix_policy_version_org', ['organizationId'])
export class PolicyVersionEntity extends PgBaseEntity {
  @Index()
  @Column({ type: 'varchar', length: 24 })
  policyId: string;

  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'int' })
  version: number;

  /** The full policy record as it stood at this version. */
  @Column({ type: 'jsonb' })
  snapshot: Record<string, unknown>;

  /** Who made the edit that closed out this version. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  changedBy: string | null;

  /** Short human summary of what changed (e.g. "start time, grace"). */
  @Column({ type: 'text', nullable: true, default: null })
  changeSummary: string | null;
}
