import { ChildEntity, Column } from 'typeorm';
import { PartnerEntity, PartnerPrimaryContact } from '../../partners/entities/partner.entity';

export type ClientStatus = 'active' | 'archived';

/** Kept as an alias so existing imports read the same. */
export type ClientPrimaryContact = PartnerPrimaryContact;

/**
 * A client company an org works with — the side we supply people TO.
 *
 * A `partners` row with `category = 'client'`: TypeORM adds that filter to every
 * query through this repository, so a client can never see a vendor and vice
 * versa. The client's people live in `client_contacts` (a contact may be
 * promoted to a portal login); the delivery team is `client_assignments`; boards
 * shared with the client are `board_client_shares`.
 */
@ChildEntity('client')
export class ClientEntity extends PartnerEntity {
  /** What the client does — the client-side wording for a vendor's service category. */
  @Column({ type: 'varchar', nullable: true, default: null })
  industry: string | null;

  declare status: ClientStatus;
}
