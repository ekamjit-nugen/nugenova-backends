import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { PushTokenEntity } from '../entities/push-token.entity';
import { FcmClient } from './fcm.client';

export interface PushWebConfig {
  enabled: boolean;
  firebase: { apiKey: string; projectId: string; messagingSenderId: string; appId: string } | null;
  vapidKey: string | null;
}

/** A user's push subscriptions + fan-out of real-time events to them over FCM. */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    @InjectRepository(PushTokenEntity) private readonly tokens: Repository<PushTokenEntity>,
    private readonly fcm: FcmClient,
    private readonly config: ConfigService,
  ) {}

  /**
   * What the web app needs to obtain a browser token. Enabled only when the server
   * can send (service account) AND the Firebase web app config + Web Push key exist.
   */
  webConfig(): PushWebConfig {
    const apiKey = this.config.get<string>('FCM_WEB_API_KEY')?.trim();
    const appId = this.config.get<string>('FCM_WEB_APP_ID')?.trim();
    const messagingSenderId = this.config.get<string>('FCM_MESSAGING_SENDER_ID')?.trim();
    const vapidKey = this.config.get<string>('VAPID_PUBLIC_KEY')?.trim() || null;
    const projectId = this.fcm.projectId;
    const firebase = apiKey && appId && messagingSenderId && projectId ? { apiKey, appId, messagingSenderId, projectId } : null;
    return { enabled: this.fcm.isConfigured() && !!firebase && !!vapidKey, firebase, vapidKey };
  }

  async register(userId: string, orgId: string | null, token: string, platform = 'web', userAgent?: string | null): Promise<void> {
    const clean = token.trim();
    const existing = await this.tokens.findOne({ where: { token: clean } });
    const row = existing ?? this.tokens.create({ token: clean });
    row.userId = userId;
    row.organizationId = orgId;
    row.platform = platform;
    row.userAgent = userAgent ? userAgent.slice(0, 300) : null;
    row.lastSeenAt = new Date();
    await this.tokens.save(row);
  }

  /** Forget a token — only the caller's own (e.g. on sign-out). */
  async unregister(userId: string, token: string): Promise<void> {
    await this.tokens.delete({ userId, token: token.trim() });
  }

  /**
   * Push a data message to every token the user has. Values are stringified (FCM
   * data must be strings); tokens FCM rejects as dead are removed. Fail-safe.
   */
  async sendToUser(userId: string, data: Record<string, unknown>): Promise<number> {
    if (!this.fcm.isConfigured()) return 0;
    try {
      const rows = await this.tokens.find({ where: { userId } });
      if (!rows.length) return 0;
      const payload = Object.fromEntries(
        Object.entries(data).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
      );
      const results = await Promise.all(rows.map(async (r) => ({ r, res: await this.fcm.send(r.token, payload) })));
      const dead = results.filter((x) => x.res === 'invalid').map((x) => x.r.id);
      if (dead.length) await this.tokens.delete(dead);
      return results.filter((x) => x.res === 'ok').length;
    } catch (e) {
      this.logger.warn(`push to ${userId} failed: ${String(e)}`);
      return 0;
    }
  }
}
