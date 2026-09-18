import { Column, Entity, Index, TableInheritance } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/** Which side of the relationship a partner sits on. */
export type PartnerCategory = 'client' | 'vendor';

/** The point of contact stored inline for quick display on the card. */
export interface PartnerPrimaryContact {
  name: string;
  email?: string | null;
  phone?: string | null;
  designation?: string | null;
}

export interface PartnerBillingAddress {
  street?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  zip?: string | null;
}

/**
 * A company we work with, on either side of the delivery relationship:
 *
 *   • **client** — we supply people to them (the delivery team assigned to them);
 *   • **vendor** — they supply people to us (contractors, who may become
 *     secondary members of the org).
 *
 * Everything else the two need is the same — profile, contacts, portal access,
 * documents, agreements — so they share one table with a `category`
 * discriminator rather than two tables that drift apart. `ClientEntity` and
 * `VendorEntity` are the child entities: their repositories add the category
 * filter automatically, so existing code keeps working unchanged.
 *
 * Ids are the ones the separate `clients` / `vendors` tables had, so every child
 * row (documents, agreements, bills, tickets, board shares) still resolves.
 */
@Entity('partners')
@TableInheritance({ column: { type: 'varchar', name: 'category' } })
@Index('ix_partners_org_category', ['organizationId', 'category'])
@Index('ix_partners_org_deleted', ['organizationId', 'isDeleted'])
export class PartnerEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  /** Set by TypeORM from the child entity; read it to tell the two apart. */
  @Column({ type: 'varchar', nullable: true, default: null })
  category: PartnerCategory;

  @Column({ type: 'varchar' })
  companyName: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  displayName: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  website: string | null;

  /** client: active | archived. vendor: active | inactive | archived. */
  @Column({ type: 'varchar', default: 'active' })
  status: string;

  @Column({ type: 'jsonb', nullable: false, default: () => `'[]'::jsonb` })
  tags: string[];

  @Column({ type: 'text', nullable: true, default: null })
  notes: string | null;

  @Column({ type: 'jsonb', nullable: true, default: null })
  primaryContact: PartnerPrimaryContact | null;

  /** Master switch for this company's portal — see the portal services. */
  @Column({ type: 'boolean', nullable: false, default: false })
  portalEnabled: boolean;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  updatedBy: string | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
