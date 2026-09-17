import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

export type ImportRowStatus = 'pending' | 'processing' | 'done' | 'skipped' | 'error';

/** One spreadsheet row of a background import, saved and tracked independently. */
@Entity('recruitment_import_rows')
@Index('ux_rec_import_rows_job_idx', ['jobId', 'idx'], { unique: true })
@Index('ix_rec_import_rows_status', ['jobId', 'status', 'idx'])
export class RecruitmentImportRowEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  jobId: string;

  @Column({ type: 'int' })
  idx: number;

  @Column({ type: 'varchar', length: 200, nullable: true, default: null })
  sheet: string | null;

  @Column({ type: 'int', nullable: true, default: null })
  rowNumber: number | null;

  /** The mapped row as sent by the import wizard (ImportRowDto). */
  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ type: 'varchar', default: 'pending' })
  status: ImportRowStatus;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'varchar', nullable: true, default: null })
  outcome: 'created' | 'merged' | 'skipped' | 'error' | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  candidateId: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true, default: null })
  fullName: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true, default: null })
  opening: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true, default: null })
  lead: string | null;

  @Column({ type: 'boolean', default: false }) appliedToOpening: boolean;
  @Column({ type: 'boolean', default: false }) submittedToLead: boolean;
  @Column({ type: 'boolean', default: false }) talentPool: boolean;
  @Column({ type: 'boolean', default: false }) openingCreated: boolean;

  @Column({ type: 'jsonb', nullable: true, default: null })
  duplicate: Record<string, unknown> | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  messages: string[];

  @Column({ type: 'timestamptz', nullable: true, default: null })
  processedAt: Date | null;
}
