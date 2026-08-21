import { BeforeInsert, CreateDateColumn, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { newObjectId } from './object-id';

/**
 * Base for every Postgres entity in the hybrid datastore.
 *
 * - `id` is a 24-char hex ObjectId string (NOT a serial/uuid) so ids stay
 *   identical to the Mongo `_id` they were migrated from and cross-engine
 *   references keep resolving. `varchar(24)` — deliberately NOT `char(24)`,
 *   which space-pads and breaks equality/returned values.
 * - `id` is app-assigned via @BeforeInsert (ETL rows set it explicitly from the
 *   Mongo `_id`; brand-new rows mint a fresh ObjectId).
 * - `createdAt`/`updatedAt` map to `created_at`/`updated_at` (snake naming
 *   strategy). During ETL they're set explicitly to preserve the original Mongo
 *   timestamps; TypeORM only auto-fills them when left undefined.
 */
export abstract class PgBaseEntity {
  @PrimaryColumn({ type: 'varchar', length: 24 })
  id: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @BeforeInsert()
  protected assignId(): void {
    if (!this.id) this.id = newObjectId();
  }
}
