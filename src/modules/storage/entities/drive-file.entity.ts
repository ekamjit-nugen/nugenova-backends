import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';
import type { DriveScope } from './drive-folder.entity';

/**
 * Cloud-drive file metadata (Postgres port of the Mongo `storage-file` schema).
 *
 * The actual bytes are NOT stored here — they are delegated to the shared
 * bootstrap `StorageService` (S3 with a Postgres-`bytea` fallback), and this row
 * only holds `storageFileId`, the id of the `document_files` row that owns the
 * bytes. This keeps a single byte store for the whole app (no second S3 layer)
 * and means the drive serves bytes exclusively through the authenticated
 * byte-proxy — never a public presigned URL.
 *
 * Tenant isolation: every read/write filters by `organizationId`; personal-scope
 * reads additionally filter by `ownerId`.
 */
@Entity('drive_files')
@Index('ix_drive_file_org', ['organizationId'])
@Index('ix_drive_file_listing', [
  'organizationId',
  'scope',
  'ownerId',
  'folderId',
  'isDeleted',
])
export class DriveFileEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'int', default: 0 })
  size: number;

  @Column({ type: 'varchar', default: 'application/octet-stream' })
  mimeType: string;

  /**
   * Id of the `document_files` row (owned by the shared StorageService) that
   * holds the actual bytes. The drive never touches S3/bytea directly.
   */
  @Column({ type: 'varchar', length: 24 })
  storageFileId: string;

  /** personal | team */
  @Column({ type: 'varchar', default: 'team' })
  scope: DriveScope;

  /** Owning user id for personal scope; null for team scope. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  ownerId: string | null;

  /** Containing folder id, or null for a drive root. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  folderId: string | null;

  @Column({ type: 'varchar', length: 24 })
  uploadedBy: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  uploadedByName: string | null;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  tags: string[];

  /** Managed by another module + hidden from normal browse. */
  @Column({ type: 'boolean', default: false })
  systemManaged: boolean;

  @Column({ type: 'boolean', default: false })
  isDeleted: boolean;
}
