import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/** Where an employee's declaration sits in the verify workflow. */
export type TaxDeclarationStatus = 'draft' | 'submitted' | 'verified' | 'rejected';

/** A proof document attached to a declaration — a reference to a `/media` file. */
export interface TaxProof {
  /** DocumentFile id from `POST /media/upload`. */
  fileId: string;
  name: string;
  size: number;
  /** Which declaration line it evidences (e.g. `section80C`). Free-form. */
  section: string;
  uploadedAt: string;
}

/**
 * TaxDeclaration — an employee's self-declared investments for a financial year,
 * feeding the old-regime TDS computation once **verified** by payroll/HR.
 *
 * One row per (org, user, financialYearStart). `financialYearStart` is the year
 * April falls in (FY 2025-26 → 2025). Amounts are annual, in RUPEES. The declared
 * figures only affect take-home under the **old** regime; a `new`-regime
 * declaration still records the employee's regime choice.
 */
@Entity('tax_declarations')
@Index('ux_tax_declaration_fy', ['organizationId', 'userId', 'financialYearStart', 'isDeleted'])
export class TaxDeclarationEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  userId: string;

  @Column({ type: 'int' })
  financialYearStart: number;

  @Column({ type: 'varchar', default: 'new' })
  regime: 'new' | 'old';

  @Column({ type: 'int', default: 0 })
  section80C: number;

  @Column({ type: 'int', default: 0 })
  section80D: number;

  @Column({ type: 'int', default: 0 })
  section80E: number;

  @Column({ type: 'int', default: 0 })
  homeLoanInterest: number;

  @Column({ type: 'int', default: 0 })
  hraExemptionAnnual: number;

  @Column({ type: 'int', default: 0 })
  otherExemptions: number;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  proofs: TaxProof[];

  @Column({ type: 'varchar', default: 'draft' })
  status: TaxDeclarationStatus;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  submittedAt: Date | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  reviewedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  reviewedAt: Date | null;

  @Column({ type: 'text', nullable: true, default: null })
  reviewNote: string | null;

  @Column({ type: 'boolean', default: false })
  isDeleted: boolean;
}
