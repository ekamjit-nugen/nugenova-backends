import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/** Append-only trail of stage moves — drives the funnel and time-in-stage. */
@Entity('application_stage_events')
@Index('ix_app_stage_events_app', ['organizationId', 'applicationId'])
export class ApplicationStageEventEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  applicationId: string;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  fromStageId: string | null;

  @Column({ type: 'varchar', length: 24 })
  toStageId: string;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  byUserId: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  note: string | null;

  @Column({ type: 'timestamptz' })
  at: Date;
}
