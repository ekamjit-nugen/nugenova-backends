import { Column, Entity } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * One Terms & Conditions document in the platform T&C **library**. The super
 * admin creates any number of these (each with a `title`/name) and assigns one to
 * an organization at creation; the org's owner then consents to it.
 *
 * A document is one of two `kind`s:
 *  - `html` — `text` holds the agreement body (from a template or hand-edited).
 *  - `pdf`  — `fileId` points at a stored PDF in `document_files`.
 *
 * `version` is this document's OWN edit counter (starts at 1, bumped on each
 * edit). An org stores the `{termsId, version}` it accepted; a higher `version`
 * (an edit) makes that consent stale and forces re-acceptance. `version` is NOT
 * globally unique — each document versions independently.
 */
@Entity('platform_terms')
export class PlatformTermsEntity extends PgBaseEntity {
  /** Display name of this T&C document (shown in the picker + consent screen). */
  @Column({ type: 'varchar', nullable: true, default: null })
  title: string | null;

  /** This document's edit version (1, 2, 3…). Bumped on each edit. */
  @Column({ type: 'int', default: 1 })
  version: number;

  /** html | pdf */
  @Column({ type: 'varchar', default: 'html' })
  kind: string;

  /** Agreement body for the `html` kind. Null for the `pdf` kind. */
  @Column({ type: 'text', nullable: true, default: null })
  text: string | null;

  /** `document_files` id of the uploaded PDF for the `pdf` kind. */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  fileId: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  updatedBy: string | null;
}
