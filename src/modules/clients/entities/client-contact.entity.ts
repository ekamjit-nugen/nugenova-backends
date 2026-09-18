import { ChildEntity, Column } from 'typeorm';
import { PartnerContactEntity } from '../../partners/entities/partner-contact.entity';

/**
 * A person at a client. A `partner_contacts` row with `category = 'client'`, so
 * this repository can only ever see client contacts.
 *
 * A contact may be a record only, or be promoted to a portal login — in which
 * case `userId` links to the `client`-role OrgMembership created for them.
 */
@ChildEntity('client')
export class ClientContactEntity extends PartnerContactEntity {
  @Column({ type: 'varchar', length: 24, nullable: true })
  clientId: string;
}
