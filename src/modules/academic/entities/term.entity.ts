import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * Term — an ordered division of an AcademicYear (semester / trimester / quarter).
 * Belongs to exactly one year (and carries `organizationId` denormalised so
 * tenant-scoped reads never need to join). `sequence` orders the terms within a
 * year and is UNIQUE per year (enforced by an index + the service), so the
 * gradebook always has a stable 1..N ordering to hang periods off.
 */
@Entity('terms')
@Index('ix_term_org', ['organizationId'])
@Index('ix_term_year', ['academicYearId'])
@Index('uq_term_year_sequence', ['academicYearId', 'sequence'], { unique: true })
export class TermEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  academicYearId: string;

  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'date' })
  startDate: string;

  @Column({ type: 'date' })
  endDate: string;

  @Column({ type: 'int' })
  sequence: number;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  createdBy: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  updatedBy: string | null;
}
