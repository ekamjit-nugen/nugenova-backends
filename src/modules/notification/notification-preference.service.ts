import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { NotificationPreferenceEntity } from './entities/notification-preference.entity';
import { categoryForType } from './notification.service';

export const NOTIFICATION_CATEGORIES = ['attendance', 'onboarding', 'policy', 'system'] as const;

export interface PreferenceView {
  inApp: boolean;
  categories: Record<string, boolean>;
  dndEnabled: boolean;
  dndAllowUrgent: boolean;
}

export interface UpdatePreferenceInput {
  inApp?: boolean;
  categories?: Record<string, boolean>;
  dndEnabled?: boolean;
  dndAllowUrgent?: boolean;
}

/**
 * NotificationPreferenceService — the per-user delivery gate. `allows()` is the
 * single enforcement point consulted by `NotifierService.notify` before a
 * notification is persisted; `get`/`update` back the Settings → Notifications UI.
 * Missing config defaults to ENABLED so untouched accounts are unaffected, and
 * every method fails OPEN (a lookup error never silently drops a notification).
 */
@Injectable()
export class NotificationPreferenceService {
  private readonly logger = new Logger(NotificationPreferenceService.name);

  constructor(
    @InjectRepository(NotificationPreferenceEntity)
    private readonly repo: Repository<NotificationPreferenceEntity>,
  ) {}

  /** The user's stored preferences, filled out with defaults for the UI. */
  async get(userId: string): Promise<PreferenceView> {
    const row = await this.repo.findOne({ where: { userId } });
    const cats: Record<string, boolean> = {};
    for (const c of NOTIFICATION_CATEGORIES) cats[c] = row?.categories?.[c] !== false;
    return {
      inApp: row?.inApp !== false,
      categories: cats,
      dndEnabled: !!row?.dndEnabled,
      dndAllowUrgent: row?.dndAllowUrgent !== false,
    };
  }

  async update(userId: string, input: UpdatePreferenceInput): Promise<PreferenceView> {
    let row = await this.repo.findOne({ where: { userId } });
    if (!row) row = this.repo.create({ userId, categories: {} });
    if (input.inApp !== undefined) row.inApp = input.inApp;
    if (input.dndEnabled !== undefined) row.dndEnabled = input.dndEnabled;
    if (input.dndAllowUrgent !== undefined) row.dndAllowUrgent = input.dndAllowUrgent;
    if (input.categories) {
      const next = { ...(row.categories || {}) };
      for (const c of NOTIFICATION_CATEGORIES) {
        if (input.categories[c] !== undefined) next[c] = input.categories[c];
      }
      row.categories = next;
    }
    await this.repo.save(row);
    return this.get(userId);
  }

  /**
   * Whether a notification of `type`/`priority` should reach `userId`. Consulted
   * at delivery time. Fails OPEN on any error.
   */
  async allows(userId: string, type: string, priority: string): Promise<boolean> {
    try {
      const row = await this.repo.findOne({ where: { userId } });
      if (!row) return true; // no prefs saved → everything on
      if (row.inApp === false) return false;
      const category = categoryForType(type);
      if (row.categories?.[category] === false) return false;
      if (row.dndEnabled) {
        const urgent = priority === 'high';
        if (!(urgent && row.dndAllowUrgent !== false)) return false;
      }
      return true;
    } catch (err) {
      this.logger.error(`allows() failed for ${userId}: ${String(err)}`);
      return true; // fail open — better a stray notification than silent loss
    }
  }
}
