import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * Organization — a tenant. Provisioned by a platform (super) admin, who names it
 * and nominates an owner; the owner then sets up departments, roles and team.
 *
 * `ownerId` is the user who administers the tenant; `createdBy` is the platform
 * admin who provisioned it. `slug` is a URL-safe unique handle derived from the
 * name at creation. Kept deliberately thin for Phase 2 — richer settings/billing
 * land with later modules.
 */
@Entity('organizations')
export class OrganizationEntity extends PgBaseEntity {
  @Column({ type: 'varchar' })
  name: string;

  @Index({ unique: true })
  @Column({ type: 'varchar' })
  slug: string;

  @Column({ type: 'varchar', default: 'active' })
  status: string; // active | suspended

  @Index()
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  ownerId: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'jsonb', nullable: true, default: null })
  settings: Record<string, unknown> | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  deletedAt: Date | null;
}
