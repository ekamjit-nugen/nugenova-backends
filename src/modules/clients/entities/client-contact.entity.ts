import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * A person at a client. A contact may be a record only, or be promoted to a
 * portal login — in which case `userId` links to the `client`-role OrgMembership
 * created for them.
 */
@Entity('client_contacts')
@Index('ix_client_contacts_client', ['clientId'])
@Index('ix_client_contacts_org', ['organizationId'])
export class ClientContactEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  clientId: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  email: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  phone: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  designation: string | null;

  /** Auth userId once this contact has a portal login; null = record only. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  userId: string | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
