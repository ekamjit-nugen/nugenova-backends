import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

export type HolidayType = 'national' | 'regional' | 'optional' | 'bank' | 'other';

/**
 * Holiday — an org-wide non-working day (applies to all employees by design, no
 * applicability scoping). `date` is stored at UTC-midnight; `year` is
 * denormalised for the year filter the calendar UI uses. A partial UNIQUE index
 * on (org, date) among non-deleted rows supports the soft-delete-then-recreate
 * path. Ported from the monolith's Holiday schema.
 */
@Entity('holidays')
@Index('uq_holiday_org_date', ['organizationId', 'date'], {
  unique: true,
  where: `"is_deleted" = false`,
})
@Index('ix_holiday_org_year', ['organizationId', 'year', 'isDeleted'])
export class HolidayEntity extends PgBaseEntity {
  @Index()
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Index()
  @Column({ type: 'timestamptz' })
  date: Date;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'varchar', default: 'national' })
  type: HolidayType;

  @Column({ type: 'varchar', length: 500, nullable: true, default: null })
  description: string | null;

  @Index()
  @Column({ type: 'int' })
  year: number;

  @Column({ type: 'boolean', default: false })
  isDeleted: boolean;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;
}
