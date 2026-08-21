import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * RevokedToken — the jti deny-list. Logout and forced sign-out add the access
 * token's `jti` here; the JWT guard rejects any token whose jti is listed. Rows
 * are safe to drop once `expiresAt` passes (the token would be rejected on
 * expiry anyway) — swept by the same periodic job as expired sessions.
 *
 * Access tokens are short-lived (15m), so this table stays tiny.
 */
@Entity('revoked_tokens')
export class RevokedTokenEntity extends PgBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar' })
  jti: string;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  userId: string | null;

  @Index()
  @Column({ type: 'timestamptz' })
  expiresAt: Date;
}
