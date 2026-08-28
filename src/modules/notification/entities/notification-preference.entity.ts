import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * NotificationPreference — one row per user, controlling what reaches them. These
 * are ENFORCED at delivery time (`NotifierService.notify` consults them before
 * persisting), so an off toggle actually stops the notification — it's not
 * cosmetic. Missing keys default to ENABLED, so an untouched account behaves as
 * before.
 */
@Entity('notification_preferences')
export class NotificationPreferenceEntity extends PgBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 24 })
  userId: string;

  /** Master in-app switch. Off ⇒ no in-app notifications at all. */
  @Column({ type: 'boolean', default: true })
  inApp: boolean;

  /**
   * Per-category in-app toggles: `{ attendance, onboarding, policy, system }`.
   * A missing/true key = on; false = that family is suppressed.
   */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  categories: Record<string, boolean>;

  /** Do Not Disturb — while on, only urgent notifications get through. */
  @Column({ type: 'boolean', default: false })
  dndEnabled: boolean;

  /** During DND, still allow high-priority (urgent) notifications through. */
  @Column({ type: 'boolean', default: true })
  dndAllowUrgent: boolean;
}
