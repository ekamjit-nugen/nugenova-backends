import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ActivityService } from '../../modules/activity/activity.service';
import { MailService } from '../mail/mail.service';
import { OrganizationEntity } from '../../modules/organization/entities/organization.entity';
import { OrgMembershipEntity } from '../../modules/auth/entities/org-membership.entity';
import { UserEntity } from '../../modules/auth/entities/user.entity';

/** Everything known about one failed request. */
export interface ReportedError {
  /** Short id shown to the caller, logged, and put in the email subject. */
  reference: string;
  status: number;
  method: string;
  path: string;
  message: string;
  /** Present for a real exception; absent when a non-Error was thrown. */
  stack?: string;
  organizationId?: string | null;
  userId?: string | null;
  userEmail?: string | null;
  ip?: string | null;
  at: Date;
}

/** Default gap between two alerts about the same route+message. */
const DEFAULT_THROTTLE_MINUTES = 15;
/** Cap on remembered signatures, so a flapping service can't grow the map forever. */
const MAX_TRACKED_SIGNATURES = 500;

@Injectable()
export class ErrorReporterService {
  private readonly logger = new Logger('ErrorReporter');
  /** signature → epoch ms of the last alert sent for it. */
  private readonly lastAlertAt = new Map<string, number>();

  constructor(
    private readonly activity: ActivityService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    @InjectRepository(OrganizationEntity)
    private readonly orgs: Repository<OrganizationEntity>,
    @InjectRepository(OrgMembershipEntity)
    private readonly memberships: Repository<OrgMembershipEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
  ) {}

  /**
   * File a failed request: one activity row always, plus an email for server
   * faults. Never throws — reporting a failure must not become one.
   */
  async report(err: ReportedError): Promise<void> {
    await this.recordActivity(err);
    if (err.status >= 500) await this.alert(err);
  }

  /**
   * The activity feed is org-scoped, so an anonymous failure (a 500 on login,
   * say) has nowhere to file — those still reach the alert email, which is why
   * the email is not conditional on this succeeding.
   */
  private async recordActivity(err: ReportedError): Promise<void> {
    if (!err.organizationId) return;
    const server = err.status >= 500;
    await this.activity.record({
      organizationId: err.organizationId,
      actorId: err.userId ?? null,
      action: server ? 'error.server' : 'error.client',
      category: 'errors',
      targetType: 'request',
      summary: `${err.status} on ${err.method} ${err.path} — ${err.message}`,
      metadata: {
        reference: err.reference,
        status: err.status,
        method: err.method,
        path: err.path,
        message: err.message,
        // The stack is the point of the whole feature: "the complete reason"
        // has to be readable from the activity entry, not just the email.
        ...(server && err.stack ? { stack: err.stack } : {}),
      },
      ip: err.ip ?? null,
    });
  }

  /**
   * Email the people who can act on a server fault: the configured ops address
   * and the org's owner. Throttled per route+message so one broken endpoint
   * under load sends a single mail, not one per request.
   */
  private async alert(err: ReportedError): Promise<void> {
    try {
      const signature = `${err.status}|${err.method} ${err.path}|${err.message}`;
      if (this.throttled(signature)) {
        this.logger.warn(`[${err.reference}] ${signature} — alert throttled`);
        return;
      }
      const to = await this.recipients(err.organizationId);
      if (to.length === 0) {
        this.logger.warn(`[${err.reference}] no alert recipients configured`);
        return;
      }
      await this.mail.send({
        to: to.map((email) => ({ email })),
        organizationId: err.organizationId ?? undefined,
        category: 'error-alert',
        subject: `[Nugenova] ${err.status} on ${err.method} ${err.path} (${err.reference})`,
        html: this.body(err),
      });
    } catch (e) {
      this.logger.warn(`[${err.reference}] alert failed: ${(e as Error).message}`);
    }
  }

  /** True when this signature was alerted on too recently. */
  private throttled(signature: string): boolean {
    const minutes = Number(this.config.get('ERROR_ALERT_THROTTLE_MIN') ?? DEFAULT_THROTTLE_MINUTES);
    const window = Math.max(0, minutes) * 60_000;
    const now = Date.now();
    const last = this.lastAlertAt.get(signature);
    if (last !== undefined && now - last < window) return true;
    if (this.lastAlertAt.size >= MAX_TRACKED_SIGNATURES) {
      for (const [k, at] of this.lastAlertAt) if (now - at >= window) this.lastAlertAt.delete(k);
    }
    this.lastAlertAt.set(signature, now);
    return false;
  }

  /** ERROR_ALERT_EMAIL (comma-separated) plus the org owner, de-duplicated. */
  private async recipients(organizationId?: string | null): Promise<string[]> {
    const out = new Set<string>();
    for (const raw of String(this.config.get('ERROR_ALERT_EMAIL') ?? '').split(',')) {
      const email = raw.trim();
      if (email) out.add(email.toLowerCase());
    }
    const owner = organizationId ? await this.ownerEmail(organizationId) : null;
    if (owner) out.add(owner.toLowerCase());
    return [...out];
  }

  private async ownerEmail(organizationId: string): Promise<string | null> {
    try {
      const org = await this.orgs.findOne({ where: { id: organizationId } });
      if (org?.ownerId) {
        const owner = await this.users.findOne({ where: { id: org.ownerId } });
        if (owner?.email) return owner.email;
      }
      const membership = await this.memberships.findOne({
        where: { organizationId, role: 'owner', status: 'active' },
      });
      if (!membership?.userId) return membership?.email ?? null;
      const user = await this.users.findOne({ where: { id: membership.userId } });
      return user?.email ?? membership.email ?? null;
    } catch {
      return null;
    }
  }

  private body(err: ReportedError): string {
    const rows: [string, string][] = [
      ['Reference', err.reference],
      ['When', err.at.toISOString()],
      ['Status', String(err.status)],
      ['Request', `${err.method} ${err.path}`],
      ['Organization', err.organizationId ?? '—'],
      ['User', err.userEmail || err.userId || 'not signed in'],
      ['IP', err.ip ?? '—'],
    ];
    const table = rows
      .map(
        ([k, v]) =>
          `<tr><td style="padding:4px 12px 4px 0;color:#64748B">${k}</td><td style="padding:4px 0;color:#0F172A"><b>${esc(v)}</b></td></tr>`,
      )
      .join('');
    return `
      <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#0F172A">
        <h2 style="margin:0 0 4px">A request failed with a ${err.status}</h2>
        <p style="margin:0 0 16px;color:#64748B">This is the complete reason, as recorded in the activity log.</p>
        <table style="border-collapse:collapse;font-size:13px">${table}</table>
        <h3 style="margin:20px 0 4px;font-size:14px">Message</h3>
        <pre style="white-space:pre-wrap;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:12px;font-size:12px">${esc(err.message)}</pre>
        ${
          err.stack
            ? `<h3 style="margin:20px 0 4px;font-size:14px">Stack</h3>
        <pre style="white-space:pre-wrap;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:12px;font-size:11.5px;color:#334155">${esc(err.stack)}</pre>`
            : ''
        }
        <p style="margin:20px 0 0;font-size:12px;color:#94A3B8">
          Further alerts about this same request are held back for a few minutes so a repeating fault doesn't flood your inbox.
        </p>
      </div>`;
  }
}

/** The stack and message are untrusted text — never interpolate them raw. */
function esc(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
