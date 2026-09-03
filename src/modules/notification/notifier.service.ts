import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { RoleEntity } from '../auth/entities/role.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { permMapAllows } from '../organization/guards/require-permission.decorator';
import { MailService } from '../../bootstrap/mail/mail.service';
import { notificationEmail } from '../../bootstrap/mail/email-layout';
import { NotificationService } from './notification.service';
import { NotificationPreferenceService } from './notification-preference.service';
import { OrgNotificationSettingService } from './org-notification-setting.service';
import { emailMetaForType, isCriticalNotification } from './notification-catalog';

/** Per-notification email control: force-off, force-on, or override the copy. */
export type EmailOption =
  | boolean
  | {
      eyebrow?: string;
      cta?: string;
      subject?: string;
      bodyHtml?: string;
      footerNote?: string;
    };

export interface NotifyInput {
  organizationId: string;
  /** Recipient userId. */
  userId: string;
  actorId?: string | null;
  type: string;
  title: string;
  body?: string | null;
  /** MUST include an `actionUrl` so the tapped notification can route. */
  data?: Record<string, unknown>;
  priority?: string;
  /**
   * Email channel control. Omit to use the type's registry default (email-worthy
   * types email, others don't). `false` forces in-app only; an object overrides
   * the email's eyebrow/subject/body/CTA.
   */
  email?: EmailOption;
}

export interface NotifyManagersInput {
  organizationId: string;
  actorId?: string | null;
  /** The permission a recipient must hold, e.g. resource `attendance` / action `edit`. */
  resource: string;
  action: string;
  type: string;
  title: string;
  body?: string | null;
  data?: Record<string, unknown>;
  priority?: string;
}

/**
 * NotifierService — the cross-module publishing spine. Any module injects this
 * and calls `notify(...)` (one recipient) or `notifyManagers(...)` (fan out to
 * the org's approvers for a permission). Delivery is **fire-and-forget and
 * fail-safe**: a notification error is logged and swallowed so it can never
 * break the business action that triggered it.
 *
 * Every payload should carry `data.actionUrl` — the web route the notification
 * routes to when tapped. `notify` skips a notification whose recipient IS the
 * actor (you don't get told about your own action).
 */
@Injectable()
export class NotifierService {
  private readonly logger = new Logger(NotifierService.name);

  constructor(
    private readonly notifications: NotificationService,
    private readonly preferences: NotificationPreferenceService,
    private readonly orgSettings: OrgNotificationSettingService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    @InjectRepository(OrgMembershipEntity)
    private readonly memberships: Repository<OrgMembershipEntity>,
    @InjectRepository(RoleEntity)
    private readonly roles: Repository<RoleEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
  ) {}

  /**
   * Whether the org-level policy permits `channel` for this recipient. The policy
   * gates EMPLOYEES only — owners/admins are never restricted — and critical
   * types bypass it entirely. Fails OPEN.
   */
  private async orgAllows(
    orgId: string,
    userId: string,
    type: string,
    channel: 'inApp' | 'email',
  ): Promise<boolean> {
    if (isCriticalNotification(type)) return true;
    try {
      const membership = await this.memberships.findOne({
        where: { organizationId: orgId, userId, status: 'active' },
        select: { role: true },
      });
      const role = (membership?.role || '').toLowerCase();
      // Owners/admins (and anyone the policy doesn't target) always pass.
      if (role !== 'member' && role !== 'employee') return true;
      return this.orgSettings.allowsForEmployee(orgId, type, channel);
    } catch {
      return true;
    }
  }

  /**
   * Notify a single recipient across BOTH channels — the in-app inbox and (for
   * email-worthy types, or when `email` is set) a branded email. The two channels
   * are independent: each has its own preference gate, and each is fire-and-forget
   * and fail-safe so a delivery error never breaks the business action.
   */
  async notify(input: NotifyInput): Promise<void> {
    if (!input.userId || !input.organizationId) return;
    // Don't notify a user about their own action.
    if (input.actorId && input.actorId === input.userId) return;
    const priority = input.priority ?? 'normal';

    // ── In-app channel ──
    try {
      const prefOk = await this.preferences.allows(input.userId, input.type, priority);
      const orgOk = await this.orgAllows(input.organizationId, input.userId, input.type, 'inApp');
      if (prefOk && orgOk) {
        await this.notifications.create({
          organizationId: input.organizationId,
          userId: input.userId,
          actorId: input.actorId ?? null,
          type: input.type,
          title: input.title,
          body: input.body ?? null,
          data: input.data ?? {},
          priority,
        });
      }
    } catch (err) {
      this.logger.error(
        `notify (in-app) failed (type=${input.type}, user=${input.userId}): ${String(err)}`,
      );
    }

    // ── Email channel (independent) ──
    await this.maybeEmail(input, priority);
  }

  /** Send the branded email for a notification, if the type/prefs warrant it. */
  private async maybeEmail(input: NotifyInput, priority: string): Promise<void> {
    try {
      if (input.email === false) return; // explicitly in-app only
      const override = typeof input.email === 'object' ? input.email : null;
      const meta = override
        ? { eyebrow: override.eyebrow ?? 'Notification', cta: override.cta, footerNote: override.footerNote }
        : emailMetaForType(input.type);
      if (!meta) return; // not an email-worthy type and no override
      if (!(await this.preferences.allowsEmail(input.userId, input.type, priority))) return;
      if (!(await this.orgAllows(input.organizationId, input.userId, input.type, 'email'))) return;
      const user = await this.users.findOne({ where: { id: input.userId } });
      if (!user?.email) return;
      const actionUrl = (input.data?.actionUrl as string) || '';
      const ctaText = override?.cta ?? meta.cta;
      const ctaUrl = ctaText && actionUrl ? this.absoluteUrl(actionUrl) : undefined;
      const { subject, html } = notificationEmail({
        eyebrow: override?.eyebrow ?? meta.eyebrow,
        title: override?.subject ?? input.title,
        body: input.body,
        bodyHtml: override?.bodyHtml,
        ctaText: ctaUrl ? ctaText : undefined,
        ctaUrl,
        footerNote: override?.footerNote ?? meta.footerNote,
      });
      await this.mail.send({
        to: { email: user.email, name: `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || undefined },
        subject,
        html,
        category: 'notification',
      });
    } catch (err) {
      this.logger.error(
        `notify (email) failed (type=${input.type}, user=${input.userId}): ${String(err)}`,
      );
    }
  }

  /** Turn a relative app path into an absolute URL for email links. */
  private absoluteUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    const base = (this.config.get<string>('FRONTEND_URL') || '').replace(/\/+$/, '');
    return base ? `${base}/${path.replace(/^\/+/, '')}` : path;
  }

  /**
   * Fan out to every active member of the org who can `resource:action` — the
   * owner/admin tiers plus any custom-role holder whose matrix grants it. Used to
   * alert approvers (e.g. a new WFH request → everyone who can review attendance).
   */
  async notifyManagers(input: NotifyManagersInput): Promise<void> {
    try {
      const recipients = await this.resolveManagers(
        input.organizationId,
        input.resource,
        input.action,
      );
      for (const userId of recipients) {
        await this.notify({
          organizationId: input.organizationId,
          userId,
          actorId: input.actorId ?? null,
          type: input.type,
          title: input.title,
          body: input.body ?? null,
          data: input.data ?? {},
          priority: input.priority ?? 'normal',
        });
      }
    } catch (err) {
      this.logger.error(`notifyManagers failed (type=${input.type}): ${String(err)}`);
    }
  }

  /**
   * userIds of active members who can `resource:action`: role owner/admin always,
   * plus custom-role members whose assigned role's permission matrix grants it.
   * Mirrors the JWT permScoped check the guards use.
   */
  async resolveManagers(
    orgId: string,
    resource: string,
    action: string,
  ): Promise<string[]> {
    const members = await this.memberships.find({
      where: { organizationId: orgId, status: 'active' },
    });
    const out = new Set<string>();
    const roleCache = new Map<string, RoleEntity | null>();

    for (const m of members) {
      if (!m.userId) continue;
      if (m.role === 'owner' || m.role === 'admin') {
        out.add(m.userId);
        continue;
      }
      const roleIds = [m.roleId, m.secondaryRoleId].filter(Boolean) as string[];
      for (const rid of roleIds) {
        let role = roleCache.get(rid);
        if (role === undefined) {
          role = await this.roles.findOne({ where: { id: rid } });
          roleCache.set(rid, role);
        }
        if (role && this.roleGrants(role, resource, action)) {
          out.add(m.userId);
          break;
        }
      }
    }
    return [...out];
  }

  /** Does a custom role's jsonb matrix grant `resource:action`? */
  private roleGrants(role: RoleEntity, resource: string, action: string): boolean {
    const map: Record<string, string[]> = {};
    for (const p of role.permissions || []) {
      if (p?.resource) map[p.resource] = p.actions || [];
    }
    // A full-access matrix may list `*` as resource or action.
    if (map['*']?.includes('*') || map['*']?.includes(action)) return true;
    const actions = map[resource];
    if (Array.isArray(actions) && actions.includes('*')) return true;
    return permMapAllows(map, resource, action);
  }
}
