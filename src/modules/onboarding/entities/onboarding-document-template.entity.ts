import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * A reusable document the super admin can request from an onboarding org — the
 * library that answers "we must have templates of all the documents super admin
 * can ask for".
 *
 * Ported in spirit from the monolith's `DocumentTemplate` (reusable field-layout)
 * plus a body: `bodyHtml` carries the agreement text / instructions, `fields`
 * carries the signature-field layout (percentage-positioned boxes, same shape as
 * the monolith's `ClientDocumentField`).
 *
 * Built-ins (`isBuiltin: true`, stable `key`) are seeded idempotently at startup
 * and shared across all orgs (`organizationId` null). Super admins can also add
 * custom templates to the library.
 */
export type DocumentFieldType =
  | 'signature'
  | 'initials'
  | 'name'
  | 'firstName'
  | 'lastName'
  | 'date'
  | 'text'
  | 'email';

export interface DocumentField {
  key: string;
  type: DocumentFieldType;
  page: number;
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
  required: boolean;
  label?: string;
}

@Entity('onboarding_document_templates')
export class OnboardingDocumentTemplateEntity extends PgBaseEntity {
  /** Stable id for built-ins (e.g. `builtin_nda`); null for custom templates. */
  @Index('uq_onboarding_template_key', { unique: true, where: `"key" IS NOT NULL` })
  @Column({ type: 'varchar', nullable: true, default: null })
  key: string | null;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'text', nullable: true, default: null })
  description: string | null;

  /** nda | msa | agreement | certificate | tax | kyc | bank | other */
  @Column({ type: 'varchar', default: 'other' })
  category: string;

  /** The agreement text / what-to-provide instructions, rendered in the portal. */
  @Column({ type: 'text', nullable: true, default: null })
  bodyHtml: string | null;

  @Column({ type: 'boolean', default: false })
  requiresSignature: boolean;

  /** Whether the org must attach a file (e.g. a certificate scan). */
  @Column({ type: 'boolean', default: false })
  requiresUpload: boolean;

  @Column({ type: 'jsonb', nullable: true, default: null })
  fields: DocumentField[] | null;

  @Column({ type: 'boolean', default: false })
  isBuiltin: boolean;

  /** Null for the shared library; reserved for future org-scoped templates. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  organizationId: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'boolean', default: false })
  isDeleted: boolean;
}
