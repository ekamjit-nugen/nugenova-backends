import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

export type VendorAgreementStatus = 'draft' | 'sent' | 'signed' | 'declined' | 'void';

/**
 * How a vendor agreement was signed. `drawn`/`typed` are captured in the app;
 * `offline` is an admin recording a paper or emailed signature on the vendor's
 * behalf — the audit trail then names the staff member who recorded it, which
 * is the honest record until the vendor portal ships and vendors sign for
 * themselves.
 */
export type VendorSignatureMethod = 'drawn' | 'typed' | 'offline';

/**
 * The e-signature record. Same shape as the client agreement's, so the frontend
 * PDF field designer and signature pad work unchanged for both.
 */
export interface VendorAgreementSignature {
  signerName: string;
  signerEmail?: string | null;
  /** The auth user who signed, or (method `offline`) the staff member who recorded it. */
  signedByUserId: string;
  signedAt: string; // ISO
  ipAddress?: string | null;
  userAgent?: string | null;
  method: VendorSignatureMethod;
  /** DocumentFile id of the drawn signature image (method `drawn`). */
  signatureFileId?: string | null;
  /** Values typed into placed text fields (name/date/…), merged by field key. */
  fieldValues?: Record<string, string>;
  /** Set when method is `offline`: how the signature actually reached us. */
  recordedNote?: string | null;
}

/**
 * A signature/name/date box placed on the attached PDF. Page-relative
 * percentages (see the frontend `@/lib/pdf-fields`), so the box lands in the
 * same spot at any render width — identical to `AgreementField` on the client
 * side, deliberately, so one designer component serves both.
 */
export interface VendorAgreementField {
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
 * An agreement between the org and a vendor — an MSA, NDA, code of conduct or
 * SOW. The document is rich text (`bodyHtml`) and/or an attached PDF
 * (`sourceFileId`).
 *
 * Lifecycle: draft → sent → signed | declined ; draft/sent → void (withdrawn).
 * Until the vendor portal exists, `sent` means "waiting on the vendor" and an
 * admin records the signature when it comes back.
 *
 * `requiredForOnboarding` is copied from the template at creation: a vendor with
 * an unsigned required agreement is not cleared to supply people, which is what
 * `clearance()` and the vendor's `onboardingStatus` read.
 */
@Entity('vendor_agreements')
@Index('ix_vendor_agreements_org', ['organizationId'])
@Index('ix_vendor_agreements_vendor', ['vendorId'])
export class VendorAgreementEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  vendorId: string;

  /** The template this was created from, when it came from one. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  templateId: string | null;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'text', nullable: true, default: null })
  description: string | null;

  /** msa | nda | sow | code_of_conduct | other */
  @Column({ type: 'varchar', default: 'other' })
  category: string;

  @Column({ type: 'text', nullable: true, default: null })
  bodyHtml: string | null;

  /** DocumentFile id of an attached PDF the vendor reads/signs; optional. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  sourceFileId: string | null;

  @Column({ type: 'jsonb', nullable: true, default: null })
  fields: VendorAgreementField[] | null;

  /** DocumentFile id of the signed copy — flattened PDF, or the scan of a paper one. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  signedFileId: string | null;

  @Column({ type: 'varchar', default: 'draft' })
  status: VendorAgreementStatus;

  /** Blocks onboarding while unsigned. Copied from the template, editable after. */
  @Column({ type: 'boolean', nullable: false, default: false })
  requiredForOnboarding: boolean;

  @Column({ type: 'jsonb', nullable: true, default: null })
  signature: VendorAgreementSignature | null;

  /** When it was sent to the vendor (status → sent). */
  @Column({ type: 'timestamptz', nullable: true, default: null })
  sentAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  signedAt: Date | null;

  /** Why the vendor declined, for the audit trail. */
  @Column({ type: 'text', nullable: true, default: null })
  declineReason: string | null;

  /** When the agreement stops being valid; null = open-ended. */
  @Column({ type: 'timestamptz', nullable: true, default: null })
  expiresAt: Date | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
