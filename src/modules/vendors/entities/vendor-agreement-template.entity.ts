import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';
import { VendorAgreementField } from './vendor-agreement.entity';

/**
 * A reusable vendor agreement — the org authors its MSA / NDA / code of conduct
 * once, then issues a copy per vendor. Creating an agreement from a template
 * copies its content, so editing the template never changes agreements already
 * out with a vendor.
 *
 * `required` + `appliesToCategories` decide which vendors must sign it:
 * an empty `appliesToCategories` means every vendor, otherwise only vendors
 * whose `serviceCategory` is in the list (e.g. only staffing partners sign the
 * background-check addendum).
 */
@Entity('vendor_agreement_templates')
@Index('ix_vendor_agreement_templates_org', ['organizationId'])
export class VendorAgreementTemplateEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  /** Template name shown in the picker. */
  @Column({ type: 'varchar' })
  name: string;

  /** Default title for agreements created from this template. */
  @Column({ type: 'varchar', nullable: true, default: null })
  title: string | null;

  /** msa | nda | sow | code_of_conduct | other */
  @Column({ type: 'varchar', default: 'other' })
  category: string;

  @Column({ type: 'text', nullable: true, default: null })
  bodyHtml: string | null;

  /** A reusable PDF stored once (optional). */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  sourceFileId: string | null;

  @Column({ type: 'jsonb', nullable: true, default: null })
  fields: VendorAgreementField[] | null;

  /** Vendors this template applies to must sign it before they are cleared. */
  @Column({ type: 'boolean', nullable: false, default: false })
  required: boolean;

  /** Service categories this applies to; empty = every vendor. */
  @Column({ type: 'jsonb', nullable: false, default: () => `'[]'::jsonb` })
  appliesToCategories: string[];

  /** Archived templates stay readable on old agreements but leave the picker. */
  @Column({ type: 'boolean', nullable: false, default: false })
  isArchived: boolean;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
