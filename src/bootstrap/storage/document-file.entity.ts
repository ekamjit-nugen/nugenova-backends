import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../database/pg-base.entity';

/**
 * A stored file (onboarding document, signed PDF, uploaded certificate).
 *
 * Two drivers write here (see StorageService):
 *  - `s3`  — bytes live in S3 under `storageKey` (`<orgId>/<uuid>.<ext>`), exactly
 *    as the monolith's media module stored them; `content` is null. Served via a
 *    presigned GET or the byte-proxy.
 *  - `db`  — no S3 configured (dev/CI): bytes live inline in `content` (bytea).
 *
 * The bucket/keys are never returned to clients (private-bucket contract) — files
 * are served only through the authenticated download endpoint.
 */
@Entity('document_files')
@Index('idx_document_file_org', ['organizationId'])
export class DocumentFileEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  uploadedBy: string | null;

  @Column({ type: 'varchar' })
  originalName: string;

  @Column({ type: 'varchar' })
  mimeType: string;

  @Column({ type: 'int' })
  size: number;

  /** s3 | db */
  @Column({ type: 'varchar', default: 'db' })
  driver: string;

  /** S3 object key (`<orgId>/<uuid>.<ext>`). Null for the db driver. */
  @Column({ type: 'varchar', nullable: true, default: null })
  storageKey: string | null;

  /** Inline bytes for the db driver. Null for the s3 driver. */
  @Column({ type: 'bytea', nullable: true, default: null })
  content: Buffer | null;

  /** Coarse grouping, e.g. `onboarding`. */
  @Column({ type: 'varchar', nullable: true, default: null })
  category: string | null;

  @Column({ type: 'boolean', default: false })
  isDeleted: boolean;
}
