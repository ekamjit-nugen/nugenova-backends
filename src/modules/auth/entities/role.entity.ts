import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * Role — a custom, per-org role definition. A member's OrgMembership may point
 * at one (roleId) or two (roleId + secondaryRoleId) of these; token generation
 * folds their permission matrices into the JWT so the frontend can gate the
 * sidebar/pages on fine-grained `perms` instead of the coarse enforced tier.
 * Postgres port of role.schema.ts.
 *
 * `role` (the enforced ENUM tier a custom role maps to) lives on the membership,
 * not here. `permissions` is a jsonb array of { resource, actions[] }. Standard
 * tiers (owner/admin/manager/employee/…) have no Role row — the tier IS the role.
 */
@Entity('roles')
@Index(['organizationId', 'isDeleted'])
export class RoleEntity extends PgBaseEntity {
  @Index()
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  displayName: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  description: string | null;

  @Index()
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  departmentId: string | null;

  /** [{ resource: string, actions: string[] }] */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  permissions: Array<{ resource: string; actions: string[] }>;

  @Column({ type: 'boolean', default: false })
  isDeleted: boolean;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;
}
