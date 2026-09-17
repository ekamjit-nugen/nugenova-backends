import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';
import type { RecruitmentCaller } from '../services/recruitment-caller';

export type ImportJobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';

/** One background spreadsheet import (a file the user committed after the preview). */
@Entity('recruitment_import_jobs')
@Index('ix_rec_import_jobs_org', ['organizationId', 'createdAt'])
export class RecruitmentImportJobEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar', length: 24 })
  createdBy: string;

  /** Permission snapshot taken when the import was started; the worker acts with it. */
  @Column({ type: 'jsonb' })
  caller: RecruitmentCaller;

  @Column({ type: 'varchar', length: 255 })
  fileName: string;

  @Column({ type: 'int', nullable: true, default: null })
  fileSize: number | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  sheetNames: string[];

  @Column({ type: 'varchar', length: 64, nullable: true, default: null })
  idempotencyKey: string | null;

  @Column({ type: 'varchar', default: 'queued' })
  status: ImportJobStatus;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  options: { defaultSource?: string; tags?: string[]; duplicates?: 'merge' | 'skip'; skipPossibleDuplicates?: boolean };

  @Column({ type: 'int', default: 0 }) totalRows: number;
  @Column({ type: 'int', default: 0 }) processedRows: number;
  @Column({ type: 'int', default: 0 }) createdCount: number;
  @Column({ type: 'int', default: 0 }) mergedCount: number;
  @Column({ type: 'int', default: 0 }) skippedCount: number;
  @Column({ type: 'int', default: 0 }) errorCount: number;
  @Column({ type: 'int', default: 0 }) flaggedCount: number;
  @Column({ type: 'int', default: 0 }) applicationsCount: number;
  @Column({ type: 'int', default: 0 }) submissionsCount: number;
  @Column({ type: 'int', default: 0 }) talentPoolCount: number;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  openingsCreated: string[];

  @Column({ type: 'boolean', default: false })
  cancelRequested: boolean;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'varchar', length: 64, nullable: true, default: null })
  lockedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  heartbeatAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  startedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  finishedAt: Date | null;

  @Column({ type: 'text', nullable: true, default: null })
  lastError: string | null;

  /** Hidden from the dashboard panel by the user (the job itself is kept). */
  @Column({ type: 'timestamptz', nullable: true, default: null })
  dismissedAt: Date | null;
}
