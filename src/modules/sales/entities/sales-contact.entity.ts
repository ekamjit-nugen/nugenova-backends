import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/** A person in the sales CRM, optionally linked to a sales account. */
@Entity('sales_contacts')
@Index('ix_sales_contacts_org', ['organizationId'])
@Index('ix_sales_contacts_account', ['accountId'])
export class SalesContactEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  email: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  phone: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  title: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  accountId: string | null;

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
