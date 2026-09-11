import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';
import { ActivityType, SalesEntityType } from '../sales.constants';

/** A timeline entry (note/call/email/meeting/…) on a lead/deal/account/contact. */
@Entity('sales_activities')
@Index('ix_sales_activities_entity', ['organizationId', 'entityType', 'entityId'])
export class SalesActivityEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar' })
  entityType: SalesEntityType;

  @Column({ type: 'varchar', length: 24 })
  entityId: string;

  @Column({ type: 'varchar' })
  type: ActivityType;

  @Column({ type: 'text', nullable: true, default: null })
  body: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  occurredAt: Date;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  createdByName: string | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
