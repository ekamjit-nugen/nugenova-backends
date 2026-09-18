import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/** A signature captured on a vendor document — same shape as the client one. */
export interface VendorDocumentSignature {
  signerName: string;
  signerEmail?: string | null;
  signedByUserId: string;
  signedAt: string; // ISO
  ipAddress?: string | null;
  userAgent?: string | null;
  method: 'drawn' | 'typed';
}

/**
 * A file we share with a vendor — a purchase order, a rate card, a policy pack.
 *
 * One-way by design: documents flow from us to the vendor only. A vendor has no
 * upload, unlike a client, so nothing arrives here from their side; what they
 * owe us is the agreements they sign.
 *
 * `signatureRequired` is the tick an admin sets when sharing: off by default, so
 * nothing is demanded of a vendor unless someone deliberately asks. When it is
 * on, the document shows in their portal as needing a signature and the captured
 * signature lands in `signature`.
 */
@Entity('vendor_documents')
@Index('ix_vendor_documents_org', ['organizationId'])
@Index('ix_vendor_documents_vendor', ['vendorId'])
export class VendorDocumentEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  vendorId: string;

  /** DocumentFile id holding the bytes. */
  @Column({ type: 'varchar', length: 24 })
  fileId: string;

  @Column({ type: 'varchar' })
  fileName: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  mimeType: string | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  size: number | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  title: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  description: string | null;

  /** We ask the vendor to sign this. Off unless an admin ticks it. */
  @Column({ type: 'boolean', nullable: false, default: false })
  signatureRequired: boolean;

  @Column({ type: 'jsonb', nullable: true, default: null })
  signature: VendorDocumentSignature | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  signedAt: Date | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  signedFileId: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
