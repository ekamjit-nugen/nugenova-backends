import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';
import { DocumentField } from './onboarding-document-template.entity';

/**
 * A specific document a super admin has requested from ONE onboarding org — the
 * per-org instance of a template (analogous to the monolith's `ClientDocument`
 * with `partyType: 'organization'`).
 *
 * State machine (faithful to the monolith's e-sign flow):
 *   requested → submitted → approved | rejected
 * A rejected document is re-opened for the org to resubmit. An org goes `active`
 * only once EVERY non-deleted request is `approved`.
 */
export interface DocumentSignature {
  signerName: string;
  signerEmail?: string | null;
  signedByUserId: string;
  signedAt: string; // ISO
  ipAddress?: string | null;
  userAgent?: string | null;
  method: 'drawn' | 'typed';
  /** DocumentFile id of the drawn signature image, when method === 'drawn'. */
  signatureFileId?: string | null;
  /** Filled values for template fields, merged by key at sign time. */
  fieldValues?: Record<string, string>;
}

export interface DocumentApproval {
  actedBy: string;
  actedAt: string; // ISO
  note?: string | null;
}

@Entity('onboarding_document_requests')
@Index('idx_onboarding_request_org', ['organizationId'])
@Index('idx_onboarding_request_status', ['status'])
export class OnboardingDocumentRequestEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  templateId: string | null;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'text', nullable: true, default: null })
  description: string | null;

  @Column({ type: 'varchar', default: 'other' })
  category: string;

  @Column({ type: 'text', nullable: true, default: null })
  bodyHtml: string | null;

  @Column({ type: 'boolean', default: false })
  requiresSignature: boolean;

  @Column({ type: 'boolean', default: false })
  requiresUpload: boolean;

  @Column({ type: 'jsonb', nullable: true, default: null })
  fields: DocumentField[] | null;

  /** requested | submitted | approved | rejected */
  @Column({ type: 'varchar', default: 'requested' })
  status: string;

  @Column({ type: 'jsonb', nullable: true, default: null })
  signature: DocumentSignature | null;

  /** DocumentFile id of the org's uploaded/submitted document. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  submittedFileId: string | null;

  @Column({ type: 'jsonb', nullable: true, default: null })
  approval: DocumentApproval | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  requestedBy: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  sharedAt: Date;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  submittedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  lastReminderAt: Date | null;

  @Column({ type: 'int', default: 0 })
  reminderCount: number;

  @Column({ type: 'boolean', default: false })
  isDeleted: boolean;
}
