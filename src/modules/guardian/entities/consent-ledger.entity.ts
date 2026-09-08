import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/** The consent basis — who authorized it (§09/§10, DPDP). */
export type ConsentBasis = 'self' | 'guardian';
export const CONSENT_BASES: readonly ConsentBasis[] = ['self', 'guardian'];

/**
 * ConsentLedger — the append-only record of consent decisions per
 * (org, subject membership, purpose). This is the MECHANISM §09 tiers 2–3 gate
 * on: an AI action above a vertical's default ceiling, or a data-processing
 * purpose, is only permitted when an ACTIVE (un-revoked) consent record exists
 * for that learner + purpose.
 *
 * Append-only style: a grant is a NEW row; a revoke SOFT-stamps `revokedAt` on
 * the active row (never a hard delete), so the full history of who consented to
 * what, when, on what basis, and when it was withdrawn is always reconstructable
 * (DPDP auditability). A re-grant after a revoke appends a fresh row.
 *
 * `grantedByMembershipId` is the SUBJECT's own membership for self-consent, or a
 * linked GUARDIAN's membership for a minor (validated against GuardianLink in the
 * service). `version` pins which edition of the consent copy was agreed.
 */
@Entity('consent_ledger')
@Index('ix_consent_org', ['organizationId'])
@Index('ix_consent_subject', ['subjectMembershipId'])
// The hot lookup: active consent for a learner + purpose.
@Index('ix_consent_lookup', ['organizationId', 'subjectMembershipId', 'purpose'])
export class ConsentLedgerEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  /** The learner the consent is ABOUT. */
  @Column({ type: 'varchar', length: 24 })
  subjectMembershipId: string;

  /** e.g. ai_tier_2 | ai_tier_3 | data_processing — the thing being consented to. */
  @Column({ type: 'varchar', length: 64 })
  purpose: string;

  /** Whether this was granted by the subject themselves or a guardian. */
  @Column({ type: 'varchar', length: 16 })
  basis: ConsentBasis;

  /** The membership that granted it (subject's own, or a linked guardian's). */
  @Column({ type: 'varchar', length: 24 })
  grantedByMembershipId: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  grantedAt: Date;

  /** Null while active; stamped when withdrawn (soft — the row is never deleted). */
  @Column({ type: 'timestamptz', nullable: true, default: null })
  revokedAt: Date | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  revokedByMembershipId: string | null;

  /** Which edition of the consent copy/policy was agreed. */
  @Column({ type: 'int', default: 1 })
  version: number;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;
}
