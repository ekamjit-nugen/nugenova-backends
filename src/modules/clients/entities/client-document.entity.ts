import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * A file an org shares with a client — deliverables, reports, contracts, etc.
 * The bytes live in the shared storage (`fileId` → DocumentFile); this row is
 * the per-client "vault" entry that makes the file visible in the client portal.
 * File metadata is denormalised so listing needs no storage round-trip.
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

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
