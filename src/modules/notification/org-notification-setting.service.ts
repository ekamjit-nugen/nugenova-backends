import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { OrgNotificationSettingEntity } from './entities/org-notification-setting.entity';
import { NOTIFICATION_CATEGORIES } from './notification-preference.service';
import { categoryForType } from './notification.service';

export type Channel = 'inApp' | 'email';

export interface OrgNotificationView {
  /** `{ [category]: { inApp, email } }` — what employees may receive per channel. */
  employeeCategories: Record<string, { inApp: boolean; email: boolean }>;
}

export interface UpdateOrgNotificationInput {
  employeeCategories?: Record<string, { inApp?: boolean; email?: boolean }>;
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

  /** Filled view for the owner's settings UI (every category, both channels). */
  async get(orgId: string): Promise<OrgNotificationView> {
    const row = await this.repo.findOne({ where: { organizationId: orgId } });
    const cats: Record<string, { inApp: boolean; email: boolean }> = {};
    for (const c of NOTIFICATION_CATEGORIES) {
      const cfg = row?.employeeCategories?.[c] ?? {};
      cats[c] = { inApp: cfg.inApp !== false, email: cfg.email !== false };
    }
    return { employeeCategories: cats };
  }

  async update(orgId: string, input: UpdateOrgNotificationInput): Promise<OrgNotificationView> {
    let row = await this.repo.findOne({ where: { organizationId: orgId } });
    if (!row) row = this.repo.create({ organizationId: orgId, employeeCategories: {} });
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
    await this.repo.save(row);
    return this.get(orgId);
  }

  /**
   * Whether the org lets its EMPLOYEES receive `type` on `channel`. Consulted by
   * NotifierService only for non-owner/admin recipients. Fails OPEN.
   */
  async allowsForEmployee(orgId: string, type: string, channel: Channel): Promise<boolean> {
    try {
      const row = await this.repo.findOne({ where: { organizationId: orgId } });
      if (!row) return true;
      const cfg = row.employeeCategories?.[categoryForType(type)];
      if (!cfg) return true;
      return cfg[channel] !== false;
    } catch (err) {
      this.logger.error(`allowsForEmployee() failed for ${orgId}: ${String(err)}`);
      return true;
    }
  }
}
