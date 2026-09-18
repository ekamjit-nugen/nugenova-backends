import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * A person at the vendor we correspond with — account manager, billing contact.
 * A record only for now; `userId` is filled when the contact is promoted to a
 * vendor-portal login (Phase 3), exactly as `client_contacts.userId` works.
 */
@Entity('vendor_contacts')
@Index('ix_vendor_contacts_vendor', ['vendorId'])
@Index('ix_vendor_contacts_org', ['organizationId'])
export class VendorContactEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  vendorId: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  email: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  phone: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  designation: string | null;

  /** The one contact shown on the vendor card and defaulted as bill recipient. */
  @Column({ type: 'boolean', nullable: false, default: false })
  isPrimary: boolean;

  /** Auth userId once this contact has a portal login; null = record only. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  userId: string | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
