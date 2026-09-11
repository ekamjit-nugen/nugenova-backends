import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

export type ClientAgreementStatus = 'draft' | 'sent' | 'signed' | 'declined' | 'void';

/**
 * The e-signature record captured when a client portal user signs an agreement.
 * Same shape as the onboarding module's `DocumentSignature` — a drawn or typed
 * signature plus the audit trail (who, when, from where) that makes it hold up.
 */
export interface AgreementSignature {
  signerName: string;
  signerEmail?: string | null;
  signedByUserId: string;
  signedAt: string; // ISO
  ipAddress?: string | null;
  userAgent?: string | null;
  method: 'drawn' | 'typed';
  /** DocumentFile id of the drawn signature image (method === 'drawn'). */
  signatureFileId?: string | null;
  /** Values typed into placed text fields (name/date/…), merged by field key. */
  fieldValues?: Record<string, string>;
}

/**
 * A signature/name/date box the org places on the attached PDF for the client to
 * fill in place. Page-relative percentages (see the frontend `@/lib/pdf-fields`),
 * so the box lands in the same spot at any render width.
 */
export interface AgreementField {
  key: string;
  type: 'signature' | 'initials' | 'name' | 'firstName' | 'lastName' | 'date' | 'text' | 'email';
  page: number;
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
  required: boolean;
  label?: string;
}

/**
 * An agreement an org sends to a client for e-signature — an NDA, SOW, MSA, etc.
 * The document is rich text (`bodyHtml`) and/or an attached PDF (`sourceFileId`);
 * the client reads it in the portal and signs (drawn/typed), which stamps the
 * `signature` audit record and moves it to `signed`.
 *
 * Lifecycle: draft → sent → signed | declined ; sent → void (withdrawn).
 */
@Entity('client_agreements')
@Index('ix_client_agreements_org', ['organizationId'])
@Index('ix_client_agreements_client', ['clientId'])
export class ClientAgreementEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  clientId: string;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'text', nullable: true, default: null })
  description: string | null;

  /** nda | sow | msa | contract | other */
  @Column({ type: 'varchar', default: 'other' })
  category: string;

  /** The agreement text (rendered in the portal); optional when a PDF is attached. */
  @Column({ type: 'text', nullable: true, default: null })
  bodyHtml: string | null;

  /** DocumentFile id of an attached PDF the client reads/signs; optional. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  sourceFileId: string | null;

  /** Signature/name/date boxes placed on the PDF for in-place signing (optional). */
  @Column({ type: 'jsonb', nullable: true, default: null })
  fields: AgreementField[] | null;

  /** DocumentFile id of the flattened, signature-embedded PDF (set on signing). */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  signedFileId: string | null;

  @Column({ type: 'varchar', default: 'draft' })
  status: ClientAgreementStatus;

  @Column({ type: 'jsonb', nullable: true, default: null })
  signature: AgreementSignature | null;

  /** When the org sent it to the client (status → sent). */
  @Column({ type: 'timestamptz', nullable: true, default: null })
  sentAt: Date | null;

  /** When the client signed it (status → signed); mirrors signature.signedAt. */
  @Column({ type: 'timestamptz', nullable: true, default: null })
  signedAt: Date | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
