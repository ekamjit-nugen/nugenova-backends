import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/** A company/organization in the sales CRM (distinct from the delivery Clients module). */
@Entity('sales_accounts')
@Index('ix_sales_accounts_org', ['organizationId'])
export class SalesAccountEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  domain: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  industry: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  size: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  website: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  phone: string | null;

  @Column({ type: 'jsonb', nullable: false, default: () => `'[]'::jsonb` })
  tags: string[];

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  assignedTo: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  lastActivityAt: Date | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
