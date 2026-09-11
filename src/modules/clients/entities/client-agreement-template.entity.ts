import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';
import { AgreementField } from './client-agreement.entity';

/**
 * A reusable agreement template — an org authors an NDA/SOW/MSA once, then
 * spins up per-client agreements from it. Carries the same content shape as an
 * agreement (rich text and/or a stored PDF with placed fields) so applying a
 * template just copies its content onto a new agreement.
 */
@Entity('client_agreement_templates')
@Index('ix_client_agreement_templates_org', ['organizationId'])
export class ClientAgreementTemplateEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  /** Template name shown in the picker. */
  @Column({ type: 'varchar' })
  name: string;

  /** Default title for agreements created from this template. */
  @Column({ type: 'varchar', nullable: true, default: null })
  title: string | null;

  /** nda | sow | msa | contract | other */
  @Column({ type: 'varchar', default: 'other' })
  category: string;

  @Column({ type: 'text', nullable: true, default: null })
  bodyHtml: string | null;

  /** A reusable PDF stored once (optional). */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  sourceFileId: string | null;

  /** Signature/name/date field layout for the PDF (optional). */
  @Column({ type: 'jsonb', nullable: true, default: null })
  fields: AgreementField[] | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
