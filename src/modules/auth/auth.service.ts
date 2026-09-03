import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, MoreThan, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import * as bcrypt from 'bcrypt';
import * as speakeasy from 'speakeasy';
import * as QRCode from 'qrcode';

import { UserEntity } from './entities/user.entity';
import { OrgMembershipEntity } from './entities/org-membership.entity';
import { SessionEntity } from './entities/session.entity';
import { RoleEntity } from './entities/role.entity';
import { OrganizationEntity } from '../organization/entities/organization.entity';
import { TermsService } from '../terms/terms.service';
import { AuditAction, AuditService } from './services/audit.service';
import { TokenRevocationService } from './services/token-revocation.service';
import { MailService } from '../../bootstrap/mail/mail.service';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface PostLoginRoute {
  route: string;
  reason: string;
  organizationId?: string;
  organizations?: string[];
}

export interface LoginResult {
  verified: boolean;
  user: UserEntity;
  tokens: AuthTokens;
  isNewUser: boolean;
  route: PostLoginRoute;
}

/**
 * AuthService — Postgres/TypeORM port of the monolith's login core.
 *
 * Scope (Phase 1): passwordless email-OTP login, the TOTP second factor, JWT
 * issue/refresh/revoke, post-login routing, and MFA enrolment. The legacy
 * password /login + /register, OAuth/SAML, SCIM, GDPR, webhooks and the rest of
 * the monolith's auth surface are intentionally NOT ported here.
 *
 * The OTP/MFA/routing/token logic is copied faithfully from the monolith so the
 * observable behaviour (and the 4 @bug fixes in SCENARIOS.md) is preserved; only
 * the persistence layer changed (Mongoose Model → TypeORM Repository, `_id` →
 * `id`). REST responses still expose the id as `id`/`_id` for frontend parity.
 */
/** Where a session was created — captured at login for the Security page. */
export interface DeviceContext {
  deviceInfo?: string;
  ipAddress?: string | null;
}

/**
 * Turn a raw User-Agent into a short, human label ("Chrome on macOS") for the
 * active-sessions list. No dependency — a small substring match covers the
 * common browsers/OSes; anything unrecognised falls back to "Browser".
 */
export function describeDevice(ua?: string | null): string {
  if (!ua || typeof ua !== 'string') return 'Unknown device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Chrome\//.test(ua) && !/Chromium/.test(ua)
        ? 'Chrome'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Version\/.*Safari/.test(ua)
            ? 'Safari'
            : 'Browser';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Android/.test(ua)
          ? 'Android'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? `${browser} on ${os}` : browser;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  // OTP throttling — env-overridable, defaults kept IDENTICAL to the monolith's
  // effective runtime (its live .env): 5 verify attempts → 30-min lockout,
  // 20 sends/hour, 30-second resend cooldown, 10-minute OTP validity.
  private readonly OTP_MAX_ATTEMPTS = parseInt(
    process.env.OTP_MAX_ATTEMPTS || '5',
    10,
  );
  private readonly OTP_LOCKOUT_MINUTES = parseInt(
    process.env.OTP_LOCKOUT_MINUTES || '30',
    10,
  );
  private readonly OTP_RATE_LIMIT_PER_HOUR = parseInt(
    process.env.OTP_RATE_LIMIT_PER_HOUR || '20',
    10,
  );
  private readonly OTP_RESEND_COOLDOWN_SECONDS = parseInt(
    process.env.OTP_RESEND_COOLDOWN_SECONDS || '30',
    10,
  );

  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    @InjectRepository(OrgMembershipEntity)
    private readonly membershipRepo: Repository<OrgMembershipEntity>,
    @InjectRepository(SessionEntity)
    private readonly sessionRepo: Repository<SessionEntity>,
    @InjectRepository(RoleEntity)
    private readonly roleRepo: Repository<RoleEntity>,
    @InjectRepository(OrganizationEntity)
    private readonly orgRepo: Repository<OrganizationEntity>,
    private readonly terms: TermsService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly auditService: AuditService,
    private readonly tokenRevocation: TokenRevocationService,
    private readonly mail: MailService,
  ) {}

  // ── OTP ──────────────────────────────────────────────────────────────────

  async sendOtp(
    email: string,
    ipAddress?: string,
  ): Promise<{ sent: boolean; isNewUser: boolean }> {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const otpHash = await bcrypt.hash(otp, 10);

    const user = await this.userRepo.findOne({
      where: { email: email.toLowerCase() },
    });

    // Invite-only sign-in: an email with no account is rejected outright (no
    // pending account is created and no code is sent). Users are always invited
    // or provisioned, so an unknown email is a genuine "no account" — we surface
    // that plainly. (This deliberately trades the anti-enumeration posture for a
    // clearer error, per product decision.)
    if (!user) {
      throw new HttpException(
        {
          success: false,
          error: {
            code: 'NO_ACCOUNT',
            message: 'No account found for this email. Ask your admin to invite you.',
          },
        },
        HttpStatus.NOT_FOUND,
      );
    }
    const isNewUser = false;

    // In dev, DEV_OTP_BYPASS makes the code always `000000`, so throttling the
    // send just gets in the way — skip the rate-limit + resend cooldown. NEVER
    // active in production (guarded on NODE_ENV), so prod throttling is intact.
    const devOtpBypass =
      process.env.DEV_OTP_BYPASS === 'true' &&
      process.env.NODE_ENV !== 'production';

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    if (
      !devOtpBypass &&
      user.otpLastRequestedAt &&
      user.otpLastRequestedAt > oneHourAgo &&
      (user.otpRequestCount || 0) >= this.OTP_RATE_LIMIT_PER_HOUR
    ) {
      throw new HttpException(
        {
          success: false,
          error: {
            code: 'RATE_LIMIT_OTP',
            message: 'Too many OTP requests. Please try again later.',
          },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (!devOtpBypass && user.otpLastRequestedAt) {
      const secondsSinceLast =
        (Date.now() - user.otpLastRequestedAt.getTime()) / 1000;
      if (secondsSinceLast < this.OTP_RESEND_COOLDOWN_SECONDS) {
        throw new HttpException(
          {
            success: false,
            error: {
              code: 'OTP_COOLDOWN',
              message: `Please wait ${Math.ceil(
                this.OTP_RESEND_COOLDOWN_SECONDS - secondsSinceLast,
              )} seconds before requesting a new OTP.`,
            },
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    if (!user.otpLastRequestedAt || user.otpLastRequestedAt < oneHourAgo) {
      user.otpRequestCount = 0;
    }

    user.otp = otpHash;
    user.otpExpiresAt = otpExpiresAt;
    user.otpAttempts = 0;
    user.otpLastRequestedAt = new Date();
    user.otpRequestCount = (user.otpRequestCount || 0) + 1;
    await this.userRepo.save(user);

    // Never print the OTP in production logs (that would leak a live login
    // code); only surface it for local/dev debugging.
    if (process.env.NODE_ENV !== 'production') {
      this.logger.log(`[DEV] OTP for ${email}: ${otp}`);
    }

    // Dev-only email skip — mirrors the verifyOtp bypass. When DEV_OTP_BYPASS is
    // on (non-prod), the magic code is always accepted, so sending mail is moot.
    // (devOtpBypass is computed once at the top of this method.)
    if (devOtpBypass) {
      this.logger.warn(
        `DEV_OTP_BYPASS active — skipping OTP email for ${email}. Use code ${
          process.env.DEV_OTP_CODE || '000000'
        }. Disable in production.`,
      );
    } else {
      await this.sendOtpEmail(email, otp);
    }

    await this.auditService.log({
      action: AuditAction.OTP_REQUESTED,
      userId: user.id,
      resource: 'user',
      resourceId: user.id,
      ipAddress,
    });

    return { sent: true, isNewUser };
  }

  /**
   * Deliver the OTP by email via the shared MailService (ZeptoMail/SMTP in
   * prod; the `outbox` driver just records it in dev/CI). `send()` never throws
   * — it returns false on a delivery failure, which we log. The DEV_OTP_BYPASS
   * path skips this entirely (the magic code is always accepted).
   */
  private async sendOtpEmail(email: string, otp: string): Promise<void> {
    const html = `
      <div style="font-family:Inter,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;padding:8px">
        <h2 style="color:#0F172A;margin:0 0 8px">Your Nugenova sign-in code</h2>
        <p style="color:#334155;margin:0 0 16px">Enter this code to finish signing in. It expires in a few minutes.</p>
        <div style="font-size:32px;font-weight:700;letter-spacing:8px;color:#2E86C1;background:#EFF6FF;border-radius:12px;padding:16px;text-align:center">${otp}</div>
        <p style="color:#94A3B8;font-size:12px;margin:16px 0 0">If you didn't request this, you can safely ignore this email.</p>
      </div>`;
    const delivered = await this.mail.send({
      to: { email },
      subject: `${otp} is your Nugenova sign-in code`,
      html,
      category: 'otp',
    });
    if (!delivered) {
      this.logger.warn(
        `OTP email to ${email} was not delivered (mailer returned false). ` +
          `Check MAIL_DRIVER / ZEPTOMAIL_* on this host.`,
      );
    }
  }

  async verifyOtp(
    email: string,
    otp: string,
    ipAddress?: string,
    deviceInfo?: string,
  ): Promise<{
    verified: boolean;
    mfaRequired?: boolean;
    mfaChallengeToken?: string;
    user: UserEntity;
    tokens?: AuthTokens;
    isNewUser: boolean;
    route?: PostLoginRoute;
  }> {
    const user = await this.userRepo.findOne({
      where: { email: email.toLowerCase() },
    });

    // Collapsed to the same generic INVALID_OTP/400 the wrong-code branch uses
    // so 404-vs-400 can't be an email-enumeration oracle (SCENARIOS @bug).
    if (!user) {
      throw new HttpException(
        {
          success: false,
          error: { code: 'INVALID_OTP', message: 'Invalid OTP. Please try again.' },
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const devOtpBypass =
      process.env.DEV_OTP_BYPASS === 'true' &&
      process.env.NODE_ENV !== 'production' &&
      otp === (process.env.DEV_OTP_CODE || '000000');
    if (devOtpBypass) {
      this.logger.warn(
        `DEV_OTP_BYPASS used for ${user.email} — accepting magic OTP without verification. Disable in production.`,
      );
    }

    if (!devOtpBypass && user.lockUntil && user.lockUntil > new Date()) {
      const minutesLeft = Math.ceil(
        (user.lockUntil.getTime() - Date.now()) / 60000,
      );
      throw new HttpException(
        {
          success: false,
          error: {
            code: 'ACCOUNT_LOCKED',
            message: `Too many attempts. Please try again in ${minutesLeft} minutes.`,
            lockoutMinutes: minutesLeft,
          },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (!devOtpBypass && user.otpAttempts >= this.OTP_MAX_ATTEMPTS) {
      user.lockUntil = new Date(
        Date.now() + this.OTP_LOCKOUT_MINUTES * 60 * 1000,
      );
      await this.userRepo.save(user);
      await this.auditService.log({
        action: AuditAction.ACCOUNT_LOCKED,
        userId: user.id,
        resource: 'user',
        resourceId: user.id,
        ipAddress,
      });
      throw new HttpException(
        {
          success: false,
          error: {
            code: 'ACCOUNT_LOCKED',
            message: `Too many attempts. Please try again in ${this.OTP_LOCKOUT_MINUTES} minutes.`,
            lockoutMinutes: this.OTP_LOCKOUT_MINUTES,
          },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (
      !devOtpBypass &&
      (!user.otp || !user.otpExpiresAt || new Date() > user.otpExpiresAt)
    ) {
      throw new HttpException(
        {
          success: false,
          error: {
            code: 'OTP_EXPIRED',
            message: 'OTP has expired. Please request a new one.',
          },
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const otpMatch =
      devOtpBypass || (!!user.otp && (await bcrypt.compare(otp, user.otp)));
    if (!otpMatch) {
      user.otpAttempts = (user.otpAttempts || 0) + 1;
      await this.userRepo.save(user);
      await this.auditService.log({
        action: AuditAction.OTP_FAILED,
        userId: user.id,
        resource: 'user',
        resourceId: user.id,
        details: { attemptsRemaining: this.OTP_MAX_ATTEMPTS - user.otpAttempts },
        ipAddress,
      });
      throw new HttpException(
        {
          success: false,
          error: {
            code: 'INVALID_OTP',
            message: 'Invalid OTP. Please try again.',
            attemptsRemaining: this.OTP_MAX_ATTEMPTS - user.otpAttempts,
          },
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    // OTP verified — clear it.
    user.otp = null;
    user.otpExpiresAt = null;
    user.otpAttempts = 0;
    user.lockUntil = null;

    const isNewUser = !user.isActive;
    if (isNewUser && user.setupStage === 'otp_verified') user.isActive = true;
    if (user.setupStage === 'invited') user.isActive = true;

    user.lastLogin = new Date();
    await this.userRepo.save(user);

    await this.auditService.log({
      action: AuditAction.OTP_VERIFIED,
      userId: user.id,
      resource: 'user',
      resourceId: user.id,
      ipAddress,
    });

    // TOTP second-factor gate: hand back a short-lived challenge token instead of
    // session tokens, and make the client clear the second factor.
    if (user.mfaEnabled) {
      await this.auditService.log({
        action: AuditAction.OTP_VERIFIED,
        userId: user.id,
        resource: 'user',
        resourceId: user.id,
        details: { mfaChallengeIssued: true },
        ipAddress,
      });
      return {
        verified: true,
        mfaRequired: true,
        mfaChallengeToken: this.signMfaChallengeToken(user.id),
        user,
        isNewUser,
      };
    }

    return this.issueLoginResult(user, isNewUser, {
      deviceInfo,
      ipAddress: ipAddress ?? null,
    });
  }

  /** 5-min JWT proving the email-OTP step passed; `purpose` claim prevents reuse. */
  private signMfaChallengeToken(userId: string): string {
    return this.jwtService.sign(
      { sub: userId, purpose: 'mfa_challenge' },
      { expiresIn: '5m' },
    );
  }

  private async issueLoginResult(
    user: UserEntity,
    isNewUser: boolean,
    device?: DeviceContext,
  ): Promise<LoginResult> {
    // Invite auto-claim is a later feature (Phase 2 people) — no-op for now.
    const routingUser = (await this.userRepo.findOne({ where: { id: user.id } })) || user;
    const route = await this.determinePostLoginRoute(routingUser);
    const tokens = await this.generateTokens(routingUser, route.organizationId, device);
    return { verified: true, user: routingUser, tokens, isNewUser, route };
  }

  async authenticateMfa(
    challengeToken: string,
    code: string,
    ipAddress?: string,
    deviceInfo?: string,
  ): Promise<LoginResult> {
    let payload: any;
    try {
      payload = this.jwtService.verify(challengeToken);
    } catch {
      payload = null;
    }
    if (!payload || payload.purpose !== 'mfa_challenge' || !payload.sub) {
      throw new HttpException(
        {
          success: false,
          error: {
            code: 'MFA_CHALLENGE_INVALID',
            message: 'Your verification session expired. Please sign in again.',
          },
        },
        HttpStatus.UNAUTHORIZED,
      );
    }

    const user = await this.userRepo.findOne({ where: { id: payload.sub } });
    if (!user || !user.mfaEnabled || !user.mfaSecret) {
      throw new HttpException(
        {
          success: false,
          error: {
            code: 'MFA_NOT_CONFIGURED',
            message: 'Two-factor authentication is not set up for this account.',
          },
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const normalized = (code || '').replace(/\s+/g, '');
    const totpValid =
      /^\d{6}$/.test(normalized) &&
      speakeasy.totp.verify({
        secret: user.mfaSecret,
        encoding: 'base32',
        token: normalized,
        window: 2,
      });

    let backupUsed = false;
    if (!totpValid) {
      const codes = user.mfaBackupCodes || [];
      const idx = codes.findIndex(
        (c) => c.toUpperCase() === normalized.toUpperCase(),
      );
      if (idx === -1) {
        throw new HttpException(
          {
            success: false,
            error: { code: 'MFA_INVALID', message: 'Invalid authentication code.' },
          },
          HttpStatus.UNAUTHORIZED,
        );
      }
      codes.splice(idx, 1);
      user.mfaBackupCodes = codes;
      backupUsed = true;
      await this.userRepo.save(user);
    }

    await this.auditService.log({
      action: AuditAction.OTP_VERIFIED,
      userId: user.id,
      resource: 'user',
      resourceId: user.id,
      details: { secondFactor: backupUsed ? 'backup_code' : 'totp' },
      ipAddress,
    });

    return this.issueLoginResult(user, false, {
      deviceInfo,
      ipAddress: ipAddress ?? null,
    });
  }

  // ── Post-login routing ─────────────────────────────────────────────────────

  async determinePostLoginRoute(user: UserEntity): Promise<PostLoginRoute> {
    if (user.isPlatformAdmin) {
      return { route: '/platform', reason: 'platform_admin' };
    }

    const memberships = await this.membershipRepo.find({
      where: {
        userId: user.id,
        status: In(['active', 'pending', 'invited']),
      },
    });

    // Case 0: client-portal — every membership is a client one.
    const clientMembership = memberships.find((m) => m.role === 'client');
    if (clientMembership && memberships.every((m) => m.role === 'client')) {
      return {
        route: '/portal',
        reason: 'client_portal',
        organizationId: clientMembership.organizationId,
      };
    }

    // Case 0b: vendor-portal — every membership is a vendor one.
    const vendorMembership = memberships.find((m) => m.role === 'vendor');
    if (vendorMembership && memberships.every((m) => m.role === 'vendor')) {
      return {
        route: '/vendor-portal',
        reason: 'vendor_portal',
        organizationId: vendorMembership.organizationId,
      };
    }

    // Case 1: brand-new user, no memberships.
    if (user.setupStage === 'otp_verified' && memberships.length === 0) {
      return { route: '/auth/setup-organization', reason: 'new_user' };
    }

    // Case 2: any pending/invited membership routes to accept-invite first (@bug #4).
    const pendingMembership = memberships.find(
      (m) => m.status === 'pending' || m.status === 'invited',
    );
    if (pendingMembership) {
      return {
        route: '/auth/accept-invite',
        reason: 'pending_invite',
        organizationId: pendingMembership.organizationId,
      };
    }

    if (user.setupStage === 'org_created') {
      return { route: '/auth/setup-profile', reason: 'incomplete_profile' };
    }

    if (user.setupStage === 'profile_complete') {
      return { route: '/auth/invite-team', reason: 'incomplete_setup' };
    }

    // Case 5: onboarded, single org.
    if (user.setupStage === 'complete' && memberships.length === 1) {
      const org = memberships[0];
      if (org.status === 'deactivated') {
        return { route: '/auth/access-denied', reason: 'membership_deactivated' };
      }
      return this.resolveOrgRoute(org);
    }

    // Case 6: multi-org.
    if (user.setupStage === 'complete' && memberships.length > 1) {
      const activeOrgs = memberships.filter((m) => m.status === 'active');
      if (activeOrgs.length === 0) {
        return {
          route: '/auth/access-denied',
          reason: 'all_memberships_deactivated',
        };
      }
      if (activeOrgs.length === 1) {
        return this.resolveOrgRoute(activeOrgs[0]);
      }
      return {
        route: '/auth/select-organization',
        reason: 'multi_org',
        organizations: activeOrgs.map((m) => m.organizationId),
      };
    }

    // Case 7: onboarded but every org removed.
    if (user.setupStage === 'complete' && memberships.length === 0) {
      return { route: '/auth/setup-organization', reason: 'no_active_org' };
    }

    return { route: '/login', reason: 'unknown_state' };
  }

  /**
   * Decide where a member of a single org lands, gating on the org's lifecycle:
   *  - `suspended` (manual halt) → `/suspended` (blocked until reactivated).
   *  - consent not accepted for the CURRENT Terms version → owners/admins go to
   *    `/consent` to accept; other members are held at access-denied.
   *  - otherwise → `/dashboard` (full app). Requested documents are non-blocking.
   */
  private async resolveOrgRoute(
    membership: OrgMembershipEntity,
  ): Promise<PostLoginRoute> {
    const org = await this.orgRepo.findOne({
      where: { id: membership.organizationId },
    });
    const organizationId = membership.organizationId;
    if (!org) {
      return { route: '/dashboard', reason: 'active_user', organizationId };
    }
    if (org.status === 'suspended') {
      return { route: '/suspended', reason: 'org_suspended', organizationId };
    }
    const needsConsent = this.terms.needsConsentActive(org.consent);
    if (needsConsent) {
      if (membership.role === 'owner' || membership.role === 'admin') {
        return { route: '/consent', reason: 'consent_required', organizationId };
      }
      return {
        route: '/auth/access-denied',
        reason: 'org_pending_consent',
        organizationId,
      };
    }
    // Owner/admin hasn't finished the workspace setup wizard yet.
    if (
      !(org as any).onboardingCompleted &&
      (membership.role === 'owner' || membership.role === 'admin')
    ) {
      return { route: '/setup', reason: 'setup_required', organizationId };
    }
    return { route: '/dashboard', reason: 'active_user', organizationId };
  }

  // ── Token generation ───────────────────────────────────────────────────────

  async generateTokens(
    user: UserEntity,
    orgId?: string,
    device?: DeviceContext,
  ): Promise<AuthTokens> {
    const resolvedOrgId = orgId || user.defaultOrganizationId || null;

    let orgRole = 'member';
    let departmentScopeId: string | null = null;
    let orgRoleName: string | null = null;
    let orgSecondaryRoleName: string | null = null;
    let clientId: string | null = null;
    let vendorId: string | null = null;
    let vendorEmployeeId: string | null = null;
    let perms: Record<string, string[]> | null = null;
    let permScoped = false;

    if (resolvedOrgId) {
      const membership = await this.membershipRepo.findOne({
        where: {
          userId: user.id,
          organizationId: resolvedOrgId,
          status: 'active',
        },
      });
      if (membership) {
        orgRole = membership.role;
        if (membership.clientId) clientId = String(membership.clientId);
        if (membership.vendorId) vendorId = String(membership.vendorId);
        if (membership.vendorEmployeeId)
          vendorEmployeeId = String(membership.vendorEmployeeId);

        if (membership.roleId || membership.secondaryRoleId) {
          const roleDoc = membership.roleId
            ? await this.roleRepo.findOne({
                where: { id: membership.roleId, isDeleted: false },
              })
            : null;
          const secRoleDoc = membership.secondaryRoleId
            ? await this.roleRepo.findOne({
                where: { id: membership.secondaryRoleId, isDeleted: false },
              })
            : null;
          if (roleDoc?.departmentId)
            departmentScopeId = String(roleDoc.departmentId);
          if (roleDoc?.displayName) orgRoleName = String(roleDoc.displayName);
          if (secRoleDoc?.displayName)
            orgSecondaryRoleName = String(secRoleDoc.displayName);

          const isAdminTier =
            orgRole === 'admin' ||
            orgRole === 'owner' ||
            user.isPlatformAdmin === true;
          if (!isAdminTier) {
            const merged: Record<string, Set<string>> = {};
            for (const doc of [roleDoc, secRoleDoc]) {
              if (!doc || !Array.isArray(doc.permissions)) continue;
              for (const p of doc.permissions) {
                if (!p?.resource) continue;
                const key = String(p.resource);
                if (!merged[key]) merged[key] = new Set();
                if (Array.isArray(p.actions))
                  p.actions.forEach((a) => merged[key].add(String(a)));
              }
            }
            if (Object.keys(merged).length || roleDoc || secRoleDoc) {
              perms = {};
              for (const [res, acts] of Object.entries(merged))
                perms[res] = [...acts];
              permScoped = true;
            }
          }
        }
      }
    }

    const tokenFamily = randomUUID();
    const accessJti = randomUUID();
    const payload = {
      sub: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      roles: user.roles,
      organizationId: resolvedOrgId,
      orgRole,
      orgRoleName,
      orgSecondaryRoleName,
      departmentScopeId,
      clientId,
      vendorId,
      vendorEmployeeId,
      perms,
      permScoped,
      setupStage: user.setupStage,
      isPlatformAdmin: user.isPlatformAdmin || false,
      family: tokenFamily,
      jti: accessJti,
    };

    // Access-token TTL (default 24h; override with JWT_EXPIRY).
    // Refresh token + session stay at 7d (below).
    const jwtExpiry = this.configService.get<string>('JWT_EXPIRY') || '24h';
    const accessToken = this.jwtService.sign(payload, {
      expiresIn: jwtExpiry as any,
    });
    const refreshToken = this.jwtService.sign(
      { sub: user.id, family: tokenFamily, organizationId: resolvedOrgId },
      { expiresIn: '7d' as any },
    );

    try {
      await this.sessionRepo.save(
        this.sessionRepo.create({
          userId: user.id,
          refreshTokenFamily: tokenFamily,
          deviceInfo: device?.deviceInfo?.trim() || 'Unknown device',
          ipAddress: device?.ipAddress ?? null,
          lastUsedAt: new Date(),
          isRevoked: false,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        }),
      );
    } catch (err: any) {
      this.logger.warn(`Failed to create session: ${err?.message || err}`);
    }

    return {
      accessToken,
      refreshToken,
      expiresIn: this.parseExpiryToSeconds(jwtExpiry),
    };
  }

  private parseExpiryToSeconds(expiry: string): number {
    const match = expiry.match(/^(\d+)(s|m|h|d)$/);
    if (!match) return 900;
    const value = parseInt(match[1], 10);
    switch (match[2]) {
      case 's':
        return value;
      case 'm':
        return value * 60;
      case 'h':
        return value * 3600;
      case 'd':
        return value * 86400;
      default:
        return 900;
    }
  }

  async generateTokensWithOrg(userId: string, orgId: string): Promise<AuthTokens> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new HttpException('User not found', HttpStatus.NOT_FOUND);
    return this.generateTokens(user, orgId);
  }

  async refreshToken(refreshToken: string): Promise<AuthTokens> {
    try {
      const payload = this.jwtService.verify(refreshToken);
      const user = await this.userRepo.findOne({ where: { id: payload.sub } });
      if (!user || !user.isActive) {
        throw new HttpException('Invalid refresh token', HttpStatus.UNAUTHORIZED);
      }

      if (payload.family) {
        const session = await this.sessionRepo.findOne({
          where: { refreshTokenFamily: payload.family, isRevoked: false },
        });
        if (!session) {
          // Reuse of a rotated/revoked family — refuse.
          this.logger.warn(`Refresh token reuse detected for user ${user.id}`);
          throw new HttpException(
            'Session has been revoked',
            HttpStatus.UNAUTHORIZED,
          );
        }
        session.isRevoked = true;
        await this.sessionRepo.save(session);
      }

      await this.auditService.log({
        action: AuditAction.TOKEN_REFRESHED,
        userId: user.id,
      });

      return this.generateTokens(
        user,
        payload.organizationId || user.defaultOrganizationId,
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException('Invalid refresh token', HttpStatus.UNAUTHORIZED);
    }
  }

  // ── Logout & sessions ──────────────────────────────────────────────────────

  async logout(
    userId: string,
    opts: { jti?: string; exp?: number; family?: string } = {},
  ): Promise<void> {
    if (opts.jti) {
      const expiresAt = opts.exp
        ? new Date(opts.exp * 1000)
        : new Date(Date.now() + 15 * 60 * 1000);
      await this.tokenRevocation.revoke(opts.jti, expiresAt, userId);
    }
    if (opts.family) {
      await this.sessionRepo.update(
        { userId, refreshTokenFamily: opts.family },
        { isRevoked: true },
      );
    }
    await this.auditService.log({ action: AuditAction.LOGOUT, userId });
  }

  async getSessions(userId: string): Promise<SessionEntity[]> {
    // Only genuinely-active sessions: not revoked AND not past expiry (an expired
    // session is dead even if the sweep hasn't removed it yet).
    return this.sessionRepo.find({
      where: { userId, isRevoked: false, expiresAt: MoreThan(new Date()) },
      order: { lastUsedAt: 'DESC', createdAt: 'DESC' },
    });
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    await this.sessionRepo.update({ id: sessionId, userId }, { isRevoked: true });
  }

  async revokeAllSessions(userId: string): Promise<void> {
    await this.sessionRepo.update({ userId }, { isRevoked: true });
  }

  // ── MFA enrolment ──────────────────────────────────────────────────────────

  async setupMFA(
    userId: string,
  ): Promise<{ secret: string; otpauthUrl: string; qrCodeDataUrl: string }> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new HttpException('User not found', HttpStatus.NOT_FOUND);

    const secret = speakeasy.generateSecret({
      name: `Nugenova (${user.email})`,
      length: 20,
    });
    // Store the secret provisionally; it only becomes active once verifyMFA
    // confirms the user can produce a valid code.
    user.mfaSecret = secret.base32;
    user.mfaMethod = 'totp';
    await this.userRepo.save(user);

    const otpauthUrl = secret.otpauth_url || '';
    // Render the otpauth URL as a scannable QR (PNG data-URL) so the user can
    // scan it instead of typing the key. Falls back to '' if rendering fails —
    // the manual key entry still works.
    let qrCodeDataUrl = '';
    try {
      if (otpauthUrl) qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 200 });
    } catch (err) {
      this.logger.warn(`QR generation failed: ${String(err)}`);
    }

    return { secret: secret.base32, otpauthUrl, qrCodeDataUrl };
  }

  async verifyMFA(
    userId: string,
    code: string,
  ): Promise<{ backupCodes: string[] }> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user || !user.mfaSecret) {
      throw new HttpException(
        'MFA setup not started',
        HttpStatus.BAD_REQUEST,
      );
    }
    const valid = speakeasy.totp.verify({
      secret: user.mfaSecret,
      encoding: 'base32',
      token: (code || '').replace(/\s+/g, ''),
      window: 2,
    });
    if (!valid) {
      throw new HttpException('Invalid authentication code', HttpStatus.BAD_REQUEST);
    }

    const backupCodes = Array.from({ length: 10 }, () =>
      randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase(),
    );
    user.mfaEnabled = true;
    user.mfaBackupCodes = backupCodes;
    await this.userRepo.save(user);

    await this.auditService.log({
      action: AuditAction.MFA_ENABLED,
      userId: user.id,
    });
    return { backupCodes };
  }

  async disableMFA(userId: string): Promise<void> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new HttpException('User not found', HttpStatus.NOT_FOUND);
    user.mfaEnabled = false;
    user.mfaSecret = null;
    user.mfaMethod = null;
    user.mfaBackupCodes = null;
    await this.userRepo.save(user);
    await this.auditService.log({
      action: AuditAction.MFA_DISABLED,
      userId: user.id,
    });
  }

  // ── Lookups ────────────────────────────────────────────────────────────────

  async getUserById(userId: string): Promise<UserEntity> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new HttpException('User not found', HttpStatus.NOT_FOUND);
    return user;
  }

  async findUserByEmail(email: string): Promise<UserEntity | null> {
    return this.userRepo.findOne({ where: { email: email.toLowerCase() } });
  }

  /** Update the current user's own profile (setup wizard step 2). */
  async updateProfile(
    userId: string,
    input: {
      firstName?: string;
      lastName?: string;
      phoneNumber?: string;
      jobTitle?: string;
      department?: string;
      bio?: string;
      location?: string;
      timezone?: string;
      linkedIn?: string;
      github?: string;
      avatar?: string;
    },
  ): Promise<UserEntity> {
    const user = await this.getUserById(userId);
    // Names can't be blanked (truthy guard); the rest clear to null on empty.
    if (input.firstName && input.firstName.trim()) user.firstName = input.firstName.trim();
    if (input.lastName !== undefined) user.lastName = input.lastName.trim();
    const setOrNull = (v: string | undefined) =>
      v === undefined ? undefined : v.trim() || null;
    const p = setOrNull(input.phoneNumber); if (p !== undefined) user.phoneNumber = p;
    const jt = setOrNull(input.jobTitle); if (jt !== undefined) user.jobTitle = jt;
    const dp = setOrNull(input.department); if (dp !== undefined) user.department = dp;
    const bio = setOrNull(input.bio); if (bio !== undefined) user.bio = bio;
    const loc = setOrNull(input.location); if (loc !== undefined) user.location = loc;
    const tz = setOrNull(input.timezone); if (tz !== undefined) user.timezone = tz;
    const li = setOrNull(input.linkedIn); if (li !== undefined) user.linkedIn = li;
    const gh = setOrNull(input.github); if (gh !== undefined) user.github = gh;
    if (input.avatar !== undefined) user.avatar = input.avatar.trim() || null;
    return this.userRepo.save(user);
  }

  async checkEmail(email: string): Promise<{ exists: boolean; isActive: boolean }> {
    const user = await this.userRepo.findOne({
      where: { email: (email || '').toLowerCase() },
    });
    return { exists: !!user, isActive: !!user?.isActive };
  }

  validateJwtPayload(payload: any): boolean {
    return !!(payload && payload.sub && payload.email);
  }

  /** Public view of a user for GET /auth/me and login responses. */
  toPublicUser(user: UserEntity): Record<string, unknown> {
    return {
      id: user.id,
      _id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      avatar: user.avatar,
      // Profile fields (settings → profile).
      phoneNumber: user.phoneNumber,
      jobTitle: user.jobTitle,
      department: user.department,
      bio: user.bio,
      location: user.location,
      timezone: user.timezone,
      linkedIn: user.linkedIn,
      github: user.github,
      roles: user.roles,
      isPlatformAdmin: user.isPlatformAdmin,
      setupStage: user.setupStage,
      mfaEnabled: user.mfaEnabled,
      defaultOrganizationId: user.defaultOrganizationId,
      organizations: user.organizations,
    };
  }

  /** Periodic cleanup of expired sessions + revoked-token rows. */
  async sweepExpired(now = new Date()): Promise<{ sessions: number; tokens: number }> {
    const sess = await this.sessionRepo.delete({ expiresAt: LessThan(now) });
    const tokens = await this.tokenRevocation.sweepExpired(now);
    return { sessions: sess.affected ?? 0, tokens };
  }
}
