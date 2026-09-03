import { Column, Entity, Index } from 'typeorm';
import { PgBaseEntity } from '../../../bootstrap/database/pg-base.entity';

/**
 * OrgNotificationSetting — one row per org, the OWNER's control over what the
 * org's EMPLOYEES receive, per category and per channel (in-app / email). It's a
 * master gate layered ABOVE each employee's own preferences: a channel the owner
 * turns off here is never delivered to an employee, even if their personal
 * preference is on.
 *
 * Scope + exceptions:
 *  - Applies to EMPLOYEES only — owners/admins manage the org and always receive
 *    their notifications (subject to their own personal preferences).
 *  - CRITICAL notifications (sign-in codes, security alerts, a Terms re-accept, a
 *    suspension notice) always send regardless of this setting — see
 *    `CRITICAL_NOTIFICATION_TYPES`.
 *
 * Shape of `employee_categories`: `{ [category]: { inApp?: boolean; email?: boolean } }`.
 * A missing category or channel defaults to ENABLED, so an unconfigured org
 * behaves as before (everything on).
 */
@Entity('org_notification_settings')
export class OrgNotificationSettingEntity extends PgBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 24 })
  organizationId: string;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  employeeCategories: Record<string, { inApp?: boolean; email?: boolean }>;
}
