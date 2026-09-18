import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

export type ClientStatus = 'active' | 'archived';

/** A primary point of contact stored inline for quick display on the client card. */
export interface ClientPrimaryContact {
  name: string;
  email?: string | null;
  phone?: string | null;
  designation?: string | null;
}

/**
 * A client company an org works with. Org-scoped. The client's people live in
 * `client_contacts` (a contact may be promoted to a portal login); the delivery
 * team is `client_assignments`; boards shared with the client are
 * `board_client_shares`. Billing/CRM + documents are Phase 2.
 */
@Entity('clients')
@Index('ix_clients_org_status', ['organizationId', 'status'])
@Index('ix_clients_org_deleted', ['organizationId', 'isDeleted'])
export class ClientEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar' })
  companyName: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  displayName: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  industry: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  website: string | null;

  @Column({ type: 'varchar', default: 'active' })
  status: ClientStatus;

  @Column({ type: 'jsonb', nullable: false, default: () => `'[]'::jsonb` })
  tags: string[];

  @Column({ type: 'text', nullable: true, default: null })
  notes: string | null;

  @Column({ type: 'jsonb', nullable: true, default: null })
  primaryContact: ClientPrimaryContact | null;

  /**
   * The master switch for this client's portal. Off means nobody at the client
   * can sign in, even someone invited earlier — checked on every portal read,
   * so turning it off locks the door immediately without deleting logins.
   */
  @Column({ type: 'boolean', nullable: false, default: false })
  portalEnabled: boolean;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  updatedBy: string | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
