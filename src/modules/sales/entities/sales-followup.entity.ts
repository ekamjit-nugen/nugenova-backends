import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';
import { FollowupStatus, SalesEntityType } from '../sales.constants';

/** A scheduled follow-up / task on a lead/deal, with a due date + reminder. */
@Entity('sales_followups')
@Index('ix_sales_followups_entity', ['organizationId', 'entityType', 'entityId'])
@Index('ix_sales_followups_due', ['organizationId', 'status', 'dueAt'])
export class SalesFollowupEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar' })
  entityType: SalesEntityType;

  @Column({ type: 'varchar', length: 24 })
  entityId: string;

  @Column({ type: 'timestamptz' })
  dueAt: Date;

  @Column({ type: 'text', nullable: true, default: null })
  note: string | null;

  @Column({ type: 'varchar', default: 'pending' })
  status: FollowupStatus;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  assignedTo: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  completedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  remindedAt: Date | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
