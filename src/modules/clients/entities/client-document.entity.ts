import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/** Who put the document here. */
export type DocumentOrigin = 'org' | 'client';

/** How a client's document reached us — `email` means staff uploaded it for them. */
export type DocumentChannel = 'portal' | 'email';

/**
 * A signature captured on a document, from either side. Same shape as the
 * agreement signature, so one signing component serves both.
 */
export interface DocumentSignature {
  signerName: string;
  signerEmail?: string | null;
  signedByUserId: string;
  signedAt: string; // ISO
  ipAddress?: string | null;
  userAgent?: string | null;
  method: 'drawn' | 'typed';
}

/**
 * A file in a client's vault, in either direction: shared BY the org (the
 * original use — deliverables, reports, contracts) or sent TO us by the client
 * from their portal. The bytes live in shared storage (`fileId` → DocumentFile);
 * this row is what makes the file visible to the other side. File metadata is
 * denormalised so listing needs no storage round-trip.
 *
 * Signing is opt-in in both directions and off by default — nothing is demanded
 * of a client unless someone deliberately asks for it:
 *   • `signatureRequired` — WE ask the client to sign (an admin ticks the box);
 *   • `signatureRequestedFromUs` — THEY ask us to sign what they sent.
 * Either way the captured signature lands in `signature`.
 */
@Entity('client_documents')
@Index('ix_client_documents_org', ['organizationId'])
@Index('ix_client_documents_client', ['clientId'])
export class ClientDocumentEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  clientId: string;

  /** DocumentFile id (from /media/upload) holding the bytes. */
  @Column({ type: 'varchar', length: 24 })
  fileId: string;

  @Column({ type: 'varchar' })
  fileName: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  mimeType: string | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  size: number | null;

  /** Optional display title + note (falls back to fileName). */
  @Column({ type: 'varchar', nullable: true, default: null })
  title: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  description: string | null;

  /** `org` = we shared it; `client` = they sent it to us. */
  @Column({ type: 'varchar', default: 'org' })
  origin: DocumentOrigin;

  /** How a client-origin document arrived; null for ones we shared. */
  @Column({ type: 'varchar', nullable: true, default: null })
  channel: DocumentChannel | null;

  /** Name to show as the sender — the portal user, or who it came from by email. */
  @Column({ type: 'varchar', nullable: true, default: null })
  uploadedByName: string | null;

  /** We asked the client to sign this. Off unless an admin ticks it. */
  @Column({ type: 'boolean', nullable: false, default: false })
  signatureRequired: boolean;

  /** They asked us to sign what they sent. */
  @Column({ type: 'boolean', nullable: false, default: false })
  signatureRequestedFromUs: boolean;

  @Column({ type: 'jsonb', nullable: true, default: null })
  signature: DocumentSignature | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  signedAt: Date | null;

  /** DocumentFile id of the signed copy, when one is uploaded with the signature. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  signedFileId: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
