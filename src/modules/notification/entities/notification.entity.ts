import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * Notification — one row per RECIPIENT. This is the isolation guarantee: a
 * notification belongs to exactly one `userId`, and every read/write in
 * `NotificationService` is scoped by that userId taken from the caller's JWT, so
 * one member can never see or mutate another member's notifications (the legacy
 * "phantom shared inbox" bug is closed by construction).
 *
 * `actorId` records WHO triggered it (the "sent" side) so the panel can show
 * both what a user received and who caused it. `data` carries the routing hint
 * (`actionUrl` + entity ids) that makes a tapped notification navigate to the
 * respective page — see the frontend `resolveNotificationRoute`.
 *
 * `read`/`readAt` track per-recipient read state. `groupKey` is reserved for
 * future WhatsApp-style collapsing (one row per conversation); unused for now.
 */
@Entity('notifications')
@Index('ix_notif_user_created', ['userId', 'createdAt'])
@Index('ix_notif_user_read', ['userId', 'read', 'isDeleted'])
@Index('ix_notif_org_user', ['organizationId', 'userId'])
export class NotificationEntity extends PgBaseEntity {
  /** Recipient org. Every trigger is org-scoped; kept NOT NULL for a clean filter. */
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  /** Recipient — the isolation key. Every query filters on this. */
  @Column({ type: 'varchar', length: 24 })
  userId: string;

  /** Who caused the notification (null for system/cron-generated events). */
  @Column({ type: 'varchar', length: 24, nullable: true, default: null })
  actorId: string | null;

  /** Machine type, e.g. `wfh_request_submitted` — drives category + routing. */
  @Column({ type: 'varchar' })
  type: string;

  /** Coarse family derived from `type` (attendance|onboarding|policy|system). */
  @Column({ type: 'varchar', default: 'system' })
  category: string;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'text', nullable: true, default: null })
  body: string | null;

  /** Routing + context: `{ actionUrl, ...entityIds }`. */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  data: Record<string, unknown>;

  /** normal | high — high survives Do-Not-Disturb (reserved for later). */
  @Column({ type: 'varchar', default: 'normal' })
  priority: string;

  @Column({ type: 'boolean', default: false })
  read: boolean;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  readAt: Date | null;

  /** Reserved for future collapse-by-conversation; null = never collapses. */
  @Column({ type: 'varchar', nullable: true, default: null })
  groupKey: string | null;

  @Column({ type: 'boolean', default: false })
  isDeleted: boolean;
}
