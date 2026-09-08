import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';
import type { DriveScope } from './drive-folder.entity';

export type GrantPermission = 'view' | 'download' | 'edit';

/**
 * Internal share grant — gives ANOTHER org member access to a file or folder the
 * grantor owns, WITHOUT a public link. Distinct from `drive_shares` (external,
 * no-login token links):
 *
 *   - `view`     → the grantee can open/preview it.
 *   - `download` → view + save a copy.
 *   - `edit`     → view + download + rename + replace the file's content.
 *     (Delete and move stay with the owner — an editor can change a document but
 *     not relocate or destroy someone else's file.)
 *
 * The grant is the DISCOVERABILITY + authorization record: the grantee finds the
 * item under "Shared with me", and the authenticated file endpoints honour the
 * grant for a non-owner. Tenant isolation: every read filters by organizationId.
 */
@Entity('drive_grants')
@Index('ux_drive_grant', ['organizationId', 'targetType', 'targetId', 'granteeUserId'], {
  unique: true,
})
@Index('ix_drive_grant_grantee', ['organizationId', 'granteeUserId'])
export class DriveGrantEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar' })
  targetType: 'file' | 'folder';

  @Column({ type: 'varchar', length: 24 })
  targetId: string;

  /** The owner's drive scope for the target (personal | team) — for resolution. */
  @Column({ type: 'varchar' })
  scope: DriveScope;

  /** The org member who receives access. */
  @Column({ type: 'varchar', length: 24 })
  granteeUserId: string;

  @Column({ type: 'varchar', default: 'view' })
  permission: GrantPermission;

  @Column({ type: 'varchar', length: 24 })
  grantedBy: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  grantedByName: string | null;
}
