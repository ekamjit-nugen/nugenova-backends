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

  /**
   * Per individual notification TYPE overrides, same channel shape as
   * `employee_categories` but keyed by event type (e.g. `attendance_absent`).
   * A type override wins over its category default; a channel not set here falls
   * back to the category. Lets an owner silence one specific event while leaving
   * the rest of its category on.
   */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  employeeTypes: Record<string, { inApp?: boolean; email?: boolean }>;

  /**
   * Which ROLES receive which emails — `{ [emailKey]: { [audience]: boolean } }`.
   * An audience is `role:<roleId>` (owners and admins always receive every email;
   * older `tier:*` / `norole` keys are ignored). Only explicit choices are stored; see EmailRoutingService for the defaults. Set
   * from the Roles & Permissions page.
   */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  emailRouting: Record<string, Record<string, boolean>>;
}
