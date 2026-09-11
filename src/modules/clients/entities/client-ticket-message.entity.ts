import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/** One message in a client ticket thread — from a client portal user or org staff. */
@Entity('client_ticket_messages')
@Index('ix_client_ticket_messages_ticket', ['ticketId'])
export class ClientTicketMessageEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  ticketId: string;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  authorId: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  authorName: string | null;

  /** 'client' or 'staff'. */
  @Column({ type: 'varchar', default: 'client' })
  authorRole: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
