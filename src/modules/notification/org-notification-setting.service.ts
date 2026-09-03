import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { OrgNotificationSettingEntity } from './entities/org-notification-setting.entity';
import { NOTIFICATION_CATEGORIES } from './notification-preference.service';
import { categoryForType } from './notification.service';
import { NOTIFICATION_TYPE_CATALOG } from './notification-catalog';

export type Channel = 'inApp' | 'email';

export interface OrgNotificationView {
  /** `{ [category]: { inApp, email } }` — the per-category default for employees. */
  employeeCategories: Record<string, { inApp: boolean; email: boolean }>;
  /**
   * RAW per-event overrides only (the events an owner explicitly customised).
   * The client computes an event's effective state as override ?? category, and
   * uses the presence of a key to show a "customised" hint.
   */
  employeeTypes: Record<string, { inApp?: boolean; email?: boolean }>;
  /** The catalog of controllable events (type, label, category) for the UI. */
  catalog: Array<{ type: string; label: string; category: string; audience: string }>;
}

export interface UpdateOrgNotificationInput {
  employeeCategories?: Record<string, { inApp?: boolean; email?: boolean }>;
  employeeTypes?: Record<string, { inApp?: boolean; email?: boolean }>;
}

/**
 * OrgNotificationSettingService — the owner's org-wide gate over what EMPLOYEES
 * receive, per category and channel. Layered above each employee's personal
 * preferences (both must allow). Owners/admins are never gated by this, and
 * critical notifications ignore it entirely. Fails OPEN.
 */
@Injectable()
export class OrgNotificationSettingService {
  private readonly logger = new Logger(OrgNotificationSettingService.name);

  constructor(
    @InjectRepository(OrgNotificationSettingEntity)
    private readonly repo: Repository<OrgNotificationSettingEntity>,
  ) {}

  /** Filled view for the owner's settings UI (categories, per-event, + catalog). */
  async get(orgId: string): Promise<OrgNotificationView> {
    const row = await this.repo.findOne({ where: { organizationId: orgId } });
    const cats: Record<string, { inApp: boolean; email: boolean }> = {};
    for (const c of NOTIFICATION_CATEGORIES) {
      const cfg = row?.employeeCategories?.[c] ?? {};
      cats[c] = { inApp: cfg.inApp !== false, email: cfg.email !== false };
    }
    // Only the RAW overrides for events actually in the catalog (ignore stale keys).
    const overrides: Record<string, { inApp?: boolean; email?: boolean }> = {};
    for (const meta of NOTIFICATION_TYPE_CATALOG) {
      const ov = row?.employeeTypes?.[meta.type];
      if (ov && (ov.inApp !== undefined || ov.email !== undefined)) overrides[meta.type] = { ...ov };
    }
    return {
      employeeCategories: cats,
      employeeTypes: overrides,
      catalog: NOTIFICATION_TYPE_CATALOG.map((t) => ({ ...t })),
    };
  }

  async update(orgId: string, input: UpdateOrgNotificationInput): Promise<OrgNotificationView> {
    let row = await this.repo.findOne({ where: { organizationId: orgId } });
    if (!row) row = this.repo.create({ organizationId: orgId, employeeCategories: {}, employeeTypes: {} });
    if (input.employeeCategories) {
      const next = { ...(row.employeeCategories || {}) };
      for (const c of NOTIFICATION_CATEGORIES) {
        const patch = input.employeeCategories[c];
        if (!patch) continue;
        const cur = { ...(next[c] || {}) };
        if (patch.inApp !== undefined) cur.inApp = patch.inApp;
        if (patch.email !== undefined) cur.email = patch.email;
        next[c] = cur;
      }
      row.employeeCategories = next;
    }
    if (input.employeeTypes) {
      const valid = new Set(NOTIFICATION_TYPE_CATALOG.map((t) => t.type));
      const next = { ...(row.employeeTypes || {}) };
      for (const [type, patch] of Object.entries(input.employeeTypes)) {
        if (!valid.has(type) || !patch) continue;
        const cur = { ...(next[type] || {}) };
        if (patch.inApp !== undefined) cur.inApp = patch.inApp;
        if (patch.email !== undefined) cur.email = patch.email;
        next[type] = cur;
      }
      row.employeeTypes = next;
    }
    await this.repo.save(row);
    return this.get(orgId);
  }

  /**
   * Whether the org lets its EMPLOYEES receive `type` on `channel`. A per-type
   * override wins over the category default; otherwise the category; otherwise
   * on. Consulted by NotifierService for non-owner/admin recipients. Fails OPEN.
   */
  async allowsForEmployee(orgId: string, type: string, channel: Channel): Promise<boolean> {
    try {
      const row = await this.repo.findOne({ where: { organizationId: orgId } });
      if (!row) return true;
      const typeOv = row.employeeTypes?.[type];
      if (typeOv && typeOv[channel] !== undefined) return typeOv[channel] !== false;
      const cat = row.employeeCategories?.[categoryForType(type)];
      if (cat && cat[channel] !== undefined) return cat[channel] !== false;
      return true;
    } catch (err) {
      this.logger.error(`allowsForEmployee() failed for ${orgId}: ${String(err)}`);
      return true;
    }
  }
}
