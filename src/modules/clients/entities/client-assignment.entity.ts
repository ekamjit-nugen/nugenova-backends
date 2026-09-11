import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * A staff member assigned to serve a client (the delivery team / account owner).
 * Assigned employees get automatic access to the client's shared boards.
 */
@Entity('client_assignments')
@Index('uq_client_assignment', ['clientId', 'userId'], { unique: true })
@Index('ix_client_assignments_user', ['organizationId', 'userId'])
export class ClientAssignmentEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  clientId: string;

  /** Auth userId of the assigned staff member. */
  @Column({ type: 'varchar', length: 24 })
  userId: string;

  /** e.g. account_manager, developer, designer. */
  @Column({ type: 'varchar', nullable: true, default: null })
  assignmentRole: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;
}
