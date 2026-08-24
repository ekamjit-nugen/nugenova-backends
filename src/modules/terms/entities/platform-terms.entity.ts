import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * A version of the global platform Terms & Conditions. Append-only: each edit
 * inserts a new row with `version = previous + 1`; the current terms are the
 * highest-versioned row. An organization's stored consent version is compared
 * against the current version to decide whether it must (re-)accept.
 *
 * A version is one of two `kind`s:
 *  - `html` — `text` holds the agreement body (from a template or hand-edited).
 *  - `pdf`  — `fileId` points at a stored PDF in `document_files`; the org reads
 *    the PDF on the consent screen. `text` is null for this kind.
 */
@Entity('platform_terms')
export class PlatformTermsEntity extends PgBaseEntity {
  @Index('uq_platform_terms_version', { unique: true })
  @Column({ type: 'int' })
  version: number;

  /** html | pdf */
  @Column({ type: 'varchar', default: 'html' })
  kind: string;

  /** Agreement body for the `html` kind. Null for the `pdf` kind. */
  @Column({ type: 'text', nullable: true, default: null })
  text: string | null;

  /** Human label (template name or uploaded PDF filename). */
  @Column({ type: 'varchar', nullable: true, default: null })
  title: string | null;

  /** `document_files` id of the uploaded PDF for the `pdf` kind. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  fileId: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  updatedBy: string | null;
}
