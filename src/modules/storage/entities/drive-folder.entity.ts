import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

export type DriveScope = 'personal' | 'team';

/**
 * Cloud-drive folder — a real, listable container (Postgres port of the Mongo
 * `storage-folder` schema).
 *
 * Two drives live in one table, discriminated by `scope`:
 *   - 'personal' — a user's private "My Drive"; `ownerId` is set and every read
 *     filters by it, so members never see each other's personal folders.
 *   - 'team'     — the shared org "Team Drive"; `ownerId` is null and it is
 *     visible to every member of the org with drive access.
 *
 * Tenant isolation: every read/write filters by `organizationId`. `path` is a
 * materialized "/A/B/C" string kept purely for breadcrumb display; `parentFolderId`
 * is the source of truth for the tree. `systemManaged` folders are hidden from
 * normal browse (mirrors the legacy behaviour for module-owned mirrors).
 */
@Entity('drive_folders')
@Index('ix_drive_folder_org', ['organizationId'])
@Index('ix_drive_folder_listing', [
  'organizationId',
  'scope',
  'ownerId',
  'parentFolderId',
  'isDeleted',
])
export class DriveFolderEntity extends PgBaseEntity {
  /** Owning org — the tenant boundary. Always set from req.user. */
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar' })
  name: string;

  /** personal | team */
  @Column({ type: 'varchar', default: 'team' })
  scope: DriveScope;

  /** The owning user id for personal scope; null for team scope. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  ownerId: string | null;

  /** Parent folder id, or null for a drive-root folder. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  parentFolderId: string | null;

  /** Materialized path for breadcrumbs, e.g. "/Project Atria/Designs". */
  @Column({ type: 'varchar', default: '/' })
  path: string;

  @Column({ type: 'varchar', length: 24 })
  createdBy: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  createdByName: string | null;

  /** Managed by another module + hidden from normal browse. */
  @Column({ type: 'boolean', default: false })
  systemManaged: boolean;

  @Column({ type: 'boolean', default: false })
  isDeleted: boolean;
}
