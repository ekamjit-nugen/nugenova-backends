import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * A file attached to a sales lead — a brief, spec, mockup, contract draft, etc.
 * The bytes live in shared storage (`fileId` → DocumentFile from /media/upload);
 * this row denormalises the metadata so listing needs no storage round-trip.
 * Mirrors the clients module's document-vault pattern.
 */
@Entity('sales_lead_documents')
@Index('ix_sales_lead_documents_lead', ['organizationId', 'leadId'])
export class LeadDocumentEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  leadId: string;

  /** DocumentFile id (from /media/upload) holding the bytes. */
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

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
