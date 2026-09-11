import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

export type TicketStatus = 'open' | 'in_progress' | 'resolved' | 'closed';
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';

/**
 * A support request / ticket a client raises from the portal (or an org opens on
 * a client's behalf). Two-way: the conversation lives in `client_ticket_messages`.
 * Org-scoped and bound to one client.
 */
@Entity('client_tickets')
@Index('ix_client_tickets_org', ['organizationId'])
@Index('ix_client_tickets_client', ['clientId'])
export class ClientTicketEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  clientId: string;

  @Column({ type: 'varchar' })
  subject: string;

  @Column({ type: 'text', nullable: true, default: null })
  description: string | null;

  /** question | issue | request | billing | other */
  @Column({ type: 'varchar', default: 'request' })
  category: string;

  @Column({ type: 'varchar', default: 'open' })
  status: TicketStatus;

  @Column({ type: 'varchar', default: 'normal' })
  priority: TicketPriority;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  createdByName: string | null;

  /** 'client' (portal) or 'staff' (org) — who opened it. */
  @Column({ type: 'varchar', default: 'client' })
  createdByRole: string;

  /** Staff member the ticket is assigned to (optional). */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  assignedToUserId: string | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  lastMessageAt: Date | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
