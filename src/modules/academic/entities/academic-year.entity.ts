import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * AcademicYear — the top of the education calendar an org's future gradebook,
 * enrolment and reporting all anchor to (the same lesson as the attendance
 * tz-day anchor: retrofitting a calendar under existing marks is a rewrite, so
 * it is laid down first). Each org owns its own years; EXACTLY ONE may be the
 * `isCurrent` year at a time (enforced by a partial-unique index + the service).
 *
 * `startDate`/`endDate` are calendar dates (no time-of-day) so they compare
 * cleanly against term bounds regardless of timezone.
 */
@Entity('academic_years')
@Index('ix_academic_year_org', ['organizationId'])
// One current academic year per org.
@Index('uq_academic_year_current', ['organizationId'], {
  unique: true,
  where: `"is_current" = true`,
})
@Index('uq_academic_year_org_name', ['organizationId', 'name'], { unique: true })
export class AcademicYearEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'date' })
  startDate: string;

  @Column({ type: 'date' })
  endDate: string;

  @Column({ type: 'boolean', default: false })
  isCurrent: boolean;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  updatedBy: string | null;
}
