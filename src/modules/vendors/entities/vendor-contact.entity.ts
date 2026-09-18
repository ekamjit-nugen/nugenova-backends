import { ChildEntity, Column } from 'typeorm';
import { PartnerContactEntity } from '../../partners/entities/partner-contact.entity';

/**
 * A person at a vendor we correspond with — account manager, billing contact.
 * A `partner_contacts` row with `category = 'vendor'`.
 *
 * `userId` is filled when the contact is promoted to a vendor-portal login,
 * exactly as it is on the client side.
 */
@ChildEntity('vendor')
export class VendorContactEntity extends PartnerContactEntity {
  @Column({ type: 'varchar', length: 24, nullable: true })
  vendorId: string;

  /** The one contact shown on the vendor card and defaulted as bill recipient. */
  @Column({ type: 'boolean', nullable: true, default: false })
  isPrimary: boolean;
}
