import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { RoleEntity } from '../auth/entities/role.entity';
import { permMapAllows } from '../organization/guards/require-permission.decorator';
import { NotificationService } from './notification.service';
import { NotificationPreferenceService } from './notification-preference.service';

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
    @InjectRepository(OrgMembershipEntity)
    private readonly memberships: Repository<OrgMembershipEntity>,
    @InjectRepository(RoleEntity)
    private readonly roles: Repository<RoleEntity>,
  ) {}

  /** Notify a single recipient. Never throws. */
  async notify(input: NotifyInput): Promise<void> {
    try {
      if (!input.userId || !input.organizationId) return;
      // Don't notify a user about their own action.
      if (input.actorId && input.actorId === input.userId) return;
      // Respect the recipient's notification preferences (fails open).
      const allowed = await this.preferences.allows(
        input.userId,
        input.type,
        input.priority ?? 'normal',
      );
      if (!allowed) return;
      await this.notifications.create({
        organizationId: input.organizationId,
        userId: input.userId,
        actorId: input.actorId ?? null,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        data: input.data ?? {},
        priority: input.priority ?? 'normal',
      });
    } catch (err) {
      this.logger.error(
        `notify failed (type=${input.type}, user=${input.userId}): ${String(err)}`,
      );
    }
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
