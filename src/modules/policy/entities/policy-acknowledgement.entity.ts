import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * PolicyAcknowledgement — one row per (policy, employee), upserted when the
 * employee acknowledges. `employeeId` is the auth **userId** (matching the
 * monolith, where the controller passed req.user.userId). `version` records
 * WHICH version was acknowledged, so bumping a policy re-arms acknowledgement.
 *
 * Ported with a fix: the row is **org-scoped** (`organizationId`) and the
 * (policy, employee) pair is UNIQUE — the monolith's ack was neither org-scoped
 * nor uniquely indexed (a cross-org ack-write leak + duplicate-ack risk).
 */
@Entity('policy_acknowledgements')
@Index('uq_policy_ack_policy_employee', ['policyId', 'employeeId'], { unique: true })
@Index('ix_policy_ack_employee', ['employeeId'])
export class PolicyAcknowledgementEntity extends PgBaseEntity {
  @Index()
  @Column({ type: 'varchar', length: 24 })
  policyId: string;

  @Index()
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  employeeId: string;

  @Column({ type: 'timestamptz' })
  acknowledgedAt: Date;

  @Column({ type: 'int' })
  version: number;
}
