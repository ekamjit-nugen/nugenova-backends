import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';
import { DocumentKind, ParseStatus } from '../recruitment.constants';

/** A file attached to a candidate (CV versions, cover letter, offer letter…). */
@Entity('candidate_documents')
@Index('ix_candidate_docs_candidate', ['organizationId', 'candidateId'])
export class CandidateDocumentEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  candidateId: string;

  /** `document_files.id` from /media/upload. */
  @Column({ type: 'varchar', length: 24 })
  fileId: string;

  @Column({ type: 'varchar', default: 'resume' })
  kind: DocumentKind;

  @Column({ type: 'varchar' })
  fileName: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  mimeType: string | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  size: string | null;

  /** The resume shown by default (one per candidate). */
  @Column({ type: 'boolean', default: false })
  isPrimary: boolean;

  @Column({ type: 'int', default: 1 })
  version: number;

  @Column({ type: 'text', nullable: true, default: null, select: false })
  extractedText: string | null;

  @Column({ type: 'varchar', default: 'pending' })
  parseStatus: ParseStatus;

  @Column({ type: 'jsonb', nullable: true, default: null })
  parsedJson: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
