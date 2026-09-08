import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';
import type { DriveScope } from './drive-folder.entity';

/**
 * External share link (Postgres port of the Mongo `storage-share` schema) — lets
 * someone OUTSIDE the org open a file or folder without a Nexora login.
 *
 * Security model:
 *   - `token` is a long random URL-safe string; the only secret in the public
 *     URL (/share/<token>). Unguessable, revocable.
 *   - `passwordHash` (bcrypt) optionally gates access; verified before any
 *     metadata/listing/download is returned.
 *   - `expiresAt` optionally auto-expires the link.
 *   - `permission` is 'view' (preview only) or 'download'.
 *   - Folder shares scope the recipient to the target folder's SUBTREE only.
 *
 * Tenant isolation: `organizationId` is stored so the public resolver can scope
 * queries to the right tenant, but the public routes never accept an orgId from
 * the caller — it is read from the share row the token resolves to.
 *
 * NOTE (byte-serving): unlike the legacy Mongo module, share downloads are NOT
 * served via a presigned S3 URL — bytes stream through the authenticated
 * server-side proxy (StorageService.openStream), matching the app's private-byte
 * posture. See DriveService.
 */
@Entity('drive_shares')
@Index('ix_drive_share_creator', ['organizationId', 'createdBy', 'revoked'])
export class DriveShareEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Index('ux_drive_share_token', { unique: true })
  @Column({ type: 'varchar' })
  token: string;

  /** file | folder */
  @Column({ type: 'varchar' })
  targetType: 'file' | 'folder';

  /** DriveFile id (file share) or DriveFolder id (folder share). */
  @Column({ type: 'varchar', length: 24 })
  targetId: string;

  /** personal | team */
  @Column({ type: 'varchar' })
  scope: DriveScope;

  /** view | download */
  @Column({ type: 'varchar', default: 'download' })
  permission: 'view' | 'download';

  @Column({ type: 'varchar', nullable: true, default: null })
  passwordHash: string | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  expiresAt: Date | null;

  @Column({ type: 'boolean', default: false })
  revoked: boolean;

  @Column({ type: 'int', default: 0 })
  accessCount: number;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  lastAccessedAt: Date | null;

  @Column({ type: 'varchar', length: 24 })
  createdBy: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  createdByName: string | null;
}
