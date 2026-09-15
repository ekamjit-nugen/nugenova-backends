import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSign } from 'crypto';

export type FcmSendResult = 'ok' | 'invalid' | 'error';

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * Minimal Firebase Cloud Messaging (HTTP v1) client — no firebase-admin dependency.
 * Authenticates with the service account in `FCM_PROJECT_ID` / `FCM_CLIENT_EMAIL` /
 * `FCM_PRIVATE_KEY` (PEM; `\n`-escaped or real newlines) via a signed JWT →
 * OAuth access token (cached until shortly before expiry), then posts data-only
 * messages. A token FCM reports as unregistered/invalid comes back as `'invalid'`
 * so the caller can forget it.
 */
@Injectable()
export class FcmClient {
  private readonly logger = new Logger(FcmClient.name);
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: ConfigService) {}

  private creds(): { projectId: string; clientEmail: string; privateKey: string } | null {
    const projectId = this.config.get<string>('FCM_PROJECT_ID')?.trim();
    const clientEmail = this.config.get<string>('FCM_CLIENT_EMAIL')?.trim();
    const raw = this.config.get<string>('FCM_PRIVATE_KEY');
    if (!projectId || !clientEmail || !raw) return null;
    const privateKey = raw.replace(/\\n/g, '\n').replace(/^"|"$/g, '');
    if (!privateKey.includes('BEGIN PRIVATE KEY') || !privateKey.includes('END PRIVATE KEY')) return null;
    return { projectId, clientEmail, privateKey };
  }

  /** True when a complete service account is configured. */
  isConfigured(): boolean {
    return !!this.creds();
  }

  get projectId(): string | null {
    return this.creds()?.projectId ?? null;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessToken.expiresAt) return this.accessToken.value;
    const c = this.creds();
    if (!c) throw new Error('FCM is not configured');
    const now = Math.floor(Date.now() / 1000);
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: c.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(c.privateKey).toString('base64url');
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !body.access_token) throw new Error(`FCM auth failed (${res.status}): ${body.error_description ?? 'no access token'}`);
    // Refresh a minute early so an in-flight send never uses an expired token.
    this.accessToken = { value: body.access_token, expiresAt: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000 };
    return body.access_token;
  }

  /** Send a data-only message to one registration token. Never throws. */
  async send(token: string, data: Record<string, string>): Promise<FcmSendResult> {
    const c = this.creds();
    if (!c) return 'error';
    try {
      const accessToken = await this.getAccessToken();
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${c.projectId}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: { token, data, webpush: { headers: { Urgency: 'high', TTL: '600' } }, android: { priority: 'high' } },
        }),
      });
      if (res.ok) return 'ok';
      const err = (await res.json().catch(() => ({}))) as { error?: { status?: string; message?: string; details?: Array<{ errorCode?: string }> } };
      const code = err.error?.details?.find((d) => d.errorCode)?.errorCode;
      if (res.status === 401) this.accessToken = null; // let the next send re-authenticate
      if (res.status === 404 || code === 'UNREGISTERED' || (res.status === 400 && /registration token/i.test(err.error?.message ?? ''))) {
        return 'invalid';
      }
      this.logger.warn(`FCM send failed (${res.status} ${code ?? err.error?.status ?? ''}): ${err.error?.message ?? ''}`);
      return 'error';
    } catch (e) {
      this.logger.warn(`FCM send error: ${String(e)}`);
      return 'error';
    }
  }
}
