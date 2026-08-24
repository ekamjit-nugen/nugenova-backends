import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * Department — an org-scoped grouping (Engineering, Sales, …). Members and custom
 * roles can be attached to one. `headUserId` is an optional department lead;
 * `parentDepartmentId` allows a shallow hierarchy. Unique by (organizationId,
 * name) among non-deleted rows.
 */
@Entity('departments')
@Index('uq_department_org_name', ['organizationId', 'name'], {
  unique: true,
  where: `"is_deleted" = false`,
})
export class DepartmentEntity extends PgBaseEntity {
  @Index()
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar' })
  name: string;

  /** Short unique code within the org (e.g. "ENG"), auto-uppercased. */
  @Column({ type: 'varchar', nullable: true, default: null })
  code: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  description: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  costCenter: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  headUserId: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  parentDepartmentId: string | null;

  @Column({ type: 'boolean', default: false })
  isDeleted: boolean;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;
}
