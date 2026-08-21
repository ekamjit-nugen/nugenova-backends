import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * OrgMembership — the pivotal user↔org join carrying the enforced `role`,
 * optional custom `roleId`/`secondaryRoleId`, invite token, and client/vendor
 * scoping. Postgres port of org-membership.schema.ts.
 *
 * Partial-unique indexes ported verbatim: one membership per (user, org) and per
 * (email, org). `cloudDrive` (Mongo Mixed) → jsonb. Refs stay indexed varchar(24)
 * (FK hardening deferred; userId/organizationId reference the identity core).
 */
@Entity('org_memberships')
@Index('uq_membership_user_org', ['userId', 'organizationId'], {
  unique: true,
  where: `"user_id" IS NOT NULL`,
})
@Index('uq_membership_email_org', ['email', 'organizationId'], {
  unique: true,
  where: `"email" IS NOT NULL`,
})
@Index(['organizationId', 'status'])
export class OrgMembershipEntity extends PgBaseEntity {
  @Index()
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  userId: string | null;

  @Index()
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  email: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  roleId: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  secondaryRoleId: string | null;

  @Column({ type: 'varchar', default: 'employee' })
  role: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  department: string | null;

  @Index()
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  clientId: string | null;

  @Index()
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  vendorId: string | null;

  @Index()
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  vendorEmployeeId: string | null;

  @Column({ type: 'varchar', default: 'active' })
  status: string;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  invitedBy: string | null;

  @Index({ where: `"invite_token" IS NOT NULL` })
  @Column({ type: 'varchar', nullable: true, default: null })
  inviteToken: string | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  inviteExpiresAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  invitedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  joinedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  deactivatedAt: Date | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  deactivatedBy: string | null;

  @Column({ type: 'jsonb', nullable: true, default: null })
  cloudDrive: Record<string, unknown> | null;
}
