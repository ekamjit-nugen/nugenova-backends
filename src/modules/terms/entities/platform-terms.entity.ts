import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * A version of the global platform Terms & Conditions. Append-only: each edit
 * inserts a new row with `version = previous + 1`; the current terms are the
 * highest-versioned row. An organization's stored consent version is compared
 * against the current version to decide whether it must (re-)accept.
 */
@Entity('platform_terms')
export class PlatformTermsEntity extends PgBaseEntity {
  @Index('uq_platform_terms_version', { unique: true })
  @Column({ type: 'int' })
  version: number;

  @Column({ type: 'text' })
  text: string;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  updatedBy: string | null;
}
