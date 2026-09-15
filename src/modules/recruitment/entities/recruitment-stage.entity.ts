import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';
import { StageKind } from '../recruitment.constants';

/** A stage in the org's hiring pipeline (seeded from DEFAULT_STAGES on first use). */
@Entity('recruitment_stages')
@Index('ix_rec_stages_org', ['organizationId'])
export class RecruitmentStageEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'int' })
  order: number;

  /** `active` = in progress; `hired` / `rejected` close the application. */
  @Column({ type: 'varchar', default: 'active' })
  kind: StageKind;

  @Column({ type: 'varchar', nullable: true, default: null })
  color: string | null;

  /** New applications land here. */
  @Column({ type: 'boolean', default: false })
  isDefault: boolean;

  @Column({ type: 'boolean', nullable: false, default: false })
  isDeleted: boolean;
}
