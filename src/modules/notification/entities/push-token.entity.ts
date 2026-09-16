import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * A device/browser that receives push (FCM) for a user. One row per token; a
 * token re-registered by another user (shared browser) moves to that user.
 * Tokens FCM reports as unregistered/invalid are deleted on send.
 */
@Entity('push_tokens')
@Index('ix_push_tokens_user', ['userId'])
export class PushTokenEntity extends PgBaseEntity {
  @Column({ type: 'varchar', length: 24 })
  userId: string;

  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  organizationId: string | null;

  @Index('ux_push_tokens_token', { unique: true })
  @Column({ type: 'text' })
  token: string;

  /** web | android | ios */
  @Column({ type: 'varchar', length: 16, default: 'web' })
  platform: string;

  @Column({ type: 'varchar', length: 300, nullable: true, default: null })
  userAgent: string | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  lastSeenAt: Date | null;
}
