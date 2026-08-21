import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * Session — one row per refresh-token family. Rotation revokes the old row and
 * mints a new family on every refresh; a refresh presented for a family with no
 * live (non-revoked) session is treated as reuse and rejected. Postgres port of
 * session.schema.ts.
 *
 * The Mongo schema had a TTL index (`expireAfterSeconds: 0`) that auto-deleted
 * expired sessions. Postgres has no TTL indexes — expired rows are swept by a
 * periodic job (see AuthService.sweepExpiredSessions) and never trusted on read.
 */
@Entity('sessions')
@Index(['userId', 'isRevoked'])
export class SessionEntity extends PgBaseEntity {
  @Index()
  @Column({ type: 'varchar', length: 24 })
  userId: string;

  @Index({ unique: true })
  @Column({ type: 'varchar' })
  refreshTokenFamily: string;

  @Column({ type: 'varchar', default: 'Unknown' })
  deviceInfo: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  ipAddress: string | null;

  @Column({ type: 'boolean', default: false })
  isRevoked: boolean;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  lastUsedAt: Date | null;

  @Index()
  @Column({ type: 'timestamptz' })
  expiresAt: Date;
}
