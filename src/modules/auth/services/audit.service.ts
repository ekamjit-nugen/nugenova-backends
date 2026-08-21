import { Injectable, Logger } from '@nestjs/common';

/**
 * Auth audit trail. In Phase 1 this writes structured lines to the app log; a
 * durable `audit_events` table + query API is a later hardening step (tracked in
 * the auth PLAYBOOK). The call sites match the monolith so swapping the sink for
 * a repository later touches only this file.
 */
export enum AuditAction {
  OTP_REQUESTED = 'OTP_REQUESTED',
  OTP_VERIFIED = 'OTP_VERIFIED',
  OTP_FAILED = 'OTP_FAILED',
  ACCOUNT_LOCKED = 'ACCOUNT_LOCKED',
  LOGIN = 'LOGIN',
  LOGOUT = 'LOGOUT',
  TOKEN_REFRESHED = 'TOKEN_REFRESHED',
  MFA_ENABLED = 'MFA_ENABLED',
  MFA_DISABLED = 'MFA_DISABLED',
}

export interface AuditEntry {
  action: AuditAction;
  userId?: string;
  resource?: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');

  async log(entry: AuditEntry): Promise<void> {
    const { action, userId, ipAddress, details } = entry;
    this.logger.log(
      `${action} user=${userId ?? '-'} ip=${ipAddress ?? '-'}${
        details ? ' ' + JSON.stringify(details) : ''
      }`,
    );
  }
}
