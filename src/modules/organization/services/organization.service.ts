import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { In, MoreThan, Repository } from 'typeorm';
import { randomUUID } from 'crypto';

import { OrganizationEntity } from '../entities/organization.entity';
import { UserEntity } from '../../auth/entities/user.entity';
import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';
import { SessionEntity } from '../../auth/entities/session.entity';
import { DepartmentEntity } from '../entities/department.entity';
import { RoleEntity } from '../../auth/entities/role.entity';
import { TermsService } from '../../terms/terms.service';
import { MailService } from '../../../bootstrap/mail/mail.service';
import { orgInviteEmail } from '../../../bootstrap/mail/email-layout';
import { CreateOrganizationDto } from '../dto';
import { PolicyService } from '../../policy/policy.service';
import { OrgRoleService } from './org-role.service';

export interface OrgPublic {
  id: string;
  name: string;
  slug: string;
  status: string; // active | suspended
  ownerId: string | null;
  createdAt: Date;
  /** The T&C document assigned to this org (from the library). */
  termsId: string | null;
  /** Whether the org has accepted its assigned T&C at its current version. */
  consentAccepted: boolean;
  /** True when consent is missing or stale (must (re-)accept). */
  needsConsent: boolean;
  consentVersion: number | null;
  consentAcceptedAt: string | null;
  /** Current version of the org's assigned T&C (null if none assigned). */
  currentTermsVersion: number | null;
  /** Owner setup-wizard progress (0 = not started; 1..3 = current step). */
  onboardingStep: number;
  /** Whether the owner finished (or skipped) the setup wizard. */
  onboardingCompleted: boolean;
  /**
   * The org's position in its lifecycle, derived for the super-admin console so
   * every state is visible at a glance:
   *  - `suspended`        — manually halted (owner blocked)
   *  - `awaiting_consent` — provisioned, owner has never accepted the T&C
   *  - `reconsent`        — accepted before, but the T&C changed → must re-accept
   *  - `setting_up`       — consent accepted, owner is running the setup wizard
   *  - `active`           — consent accepted and setup finished
   */
  lifecycle:
    | 'suspended'
    | 'awaiting_consent'
    | 'reconsent'
    | 'setting_up'
    | 'active';
}

/**
 * Organization provisioning — the platform-admin-facing half of onboarding.
 * A super admin names an org and nominates an owner; this creates the org, the
 * owner user (if new), and the owner's active membership, and points the owner
 * at the new org so their next login lands inside it.
 */
@Injectable()
export class OrganizationService {
  private readonly logger = new Logger(OrganizationService.name);

  constructor(
    @InjectRepository(OrganizationEntity)
    private readonly orgRepo: Repository<OrganizationEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    @InjectRepository(OrgMembershipEntity)
    private readonly membershipRepo: Repository<OrgMembershipEntity>,
    @InjectRepository(SessionEntity)
    private readonly sessionRepo: Repository<SessionEntity>,
    @InjectRepository(DepartmentEntity)
    private readonly departmentRepo: Repository<DepartmentEntity>,
    @InjectRepository(RoleEntity)
    private readonly roleRepo: Repository<RoleEntity>,
    private readonly terms: TermsService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    private readonly policies: PolicyService,
    private readonly roles: OrgRoleService,
  ) {}

  private frontendUrl(): string {
    return (
      this.config.get<string>('FRONTEND_URL') || 'http://localhost:3111'
    ).replace(/\/+$/, '');
  }

  /** True when the org has not accepted the ACTIVE platform T&C at its version. */
  needsConsent(o: OrganizationEntity): boolean {
    return this.terms.needsConsentActive(o.consent);
  }

  /** How many orgs are assigned a given T&C — gates deletion of that document. */
  async countUsingTerms(termsId: string): Promise<number> {
    return this.orgRepo.count({ where: { termsId, deletedAt: null as any } });
  }

  private async getEntity(id: string): Promise<OrganizationEntity> {
    const org = await this.orgRepo.findOne({ where: { id } });
    if (!org) throw new NotFoundException('Organization not found');
    return org;
  }

  private async uniqueSlug(name: string): Promise<string> {
    const base =
      name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'org';
    let slug = base;
    // Append a short suffix until unique.
    while (await this.orgRepo.findOne({ where: { slug } })) {
      slug = `${base}-${randomUUID().slice(0, 6)}`;
    }
    return slug;
  }

  toPublic(o: OrganizationEntity): OrgPublic {
    const currentTermsVersion = this.terms.getActive()?.version ?? null;
    const needsConsent = this.needsConsent(o);
    const onboardingCompleted = !!o.onboardingCompleted;

    // Derive the single lifecycle state the super-admin console reads.
    let lifecycle: OrgPublic['lifecycle'];
    if (o.status === 'suspended') {
      lifecycle = 'suspended';
    } else if (needsConsent) {
      // A recorded (now stale) consent version means they accepted once before.
      lifecycle = o.consent?.version != null ? 'reconsent' : 'awaiting_consent';
    } else if (!onboardingCompleted) {
      lifecycle = 'setting_up';
    } else {
      lifecycle = 'active';
    }

    return {
      id: o.id,
      name: o.name,
      slug: o.slug,
      status: o.status,
      ownerId: o.ownerId,
      createdAt: o.createdAt,
      termsId: o.termsId ?? null,
      consentAccepted: !needsConsent,
      needsConsent,
      consentVersion: o.consent?.version ?? null,
      consentAcceptedAt: o.consent?.acceptedAt ?? null,
      currentTermsVersion,
      onboardingStep: o.onboardingStep ?? 0,
      onboardingCompleted,
      lifecycle,
    };
  }

  async createOrganization(
    dto: CreateOrganizationDto,
    createdByUserId: string,
  ): Promise<{ organization: OrgPublic; owner: { id: string; email: string } }> {
    // Resolve or create the nominated owner.
    let owner = await this.userRepo.findOne({
      where: { email: dto.ownerEmail.toLowerCase() },
    });
    if (!owner) {
      owner = this.userRepo.create({
        email: dto.ownerEmail.toLowerCase(),
        password: 'pending-otp-' + randomUUID(),
        firstName: dto.ownerFirstName || 'Owner',
        lastName: dto.ownerLastName || '',
        isActive: true,
        setupStage: 'complete',
      });
      owner = await this.userRepo.save(owner);
    }

    // Terms are platform-wide now: every org gates on the single ACTIVE T&C, so
    // provisioning no longer picks one. Record the active id for reference (if a
    // caller still passes a valid termsId, honour it; otherwise use the active).
    const activeTermsId = this.terms.getActive()?.id ?? null;
    const termsId =
      dto.termsId && (await this.terms.exists(dto.termsId))
        ? dto.termsId
        : activeTermsId;

    const slug = await this.uniqueSlug(dto.name);
    // Provisioned orgs are `active` with NO consent yet — the owner can sign in
    // but is routed to the consent screen and blocked from the app until they
    // accept the active Terms & Conditions. `suspended` is a manual halt.
    const org = await this.orgRepo.save(
      this.orgRepo.create({
        name: dto.name.trim(),
        slug,
        status: 'active',
        termsId,
        consent: null,
        ownerId: owner.id,
        createdBy: createdByUserId,
      }),
    );

    // Seed the org's roles first so every tier is a real, visible row and the
    // owner can be attached to the actual Owner role (roleId), not a bare tier.
    await this.roles
      .seedDefaults(org.id, createdByUserId)
      .catch((e) =>
        this.logger.warn(`Role seed failed for ${org.id}: ${e?.message ?? e}`),
      );
    const ownerRole = await this.roles.systemRoleForTier(org.id, 'owner');

    // Owner membership — refuse a duplicate (idempotency guard).
    const existing = await this.membershipRepo.findOne({
      where: { userId: owner.id, organizationId: org.id },
    });
    if (existing) {
      throw new ConflictException('Owner already belongs to this organization');
    }
    await this.membershipRepo.save(
      this.membershipRepo.create({
        userId: owner.id,
        organizationId: org.id,
        role: 'owner',
        roleId: ownerRole?.id ?? null,
        status: 'active',
        joinedAt: new Date(),
        invitedBy: createdByUserId,
      }),
    );

    // Point the owner at the new org so login routes there.
    const orgs = new Set(owner.organizations || []);
    orgs.add(org.id);
    owner.organizations = [...orgs];
    if (!owner.defaultOrganizationId) owner.defaultOrganizationId = org.id;
    if (owner.setupStage !== 'complete') owner.setupStage = 'complete';
    owner.isActive = true;
    await this.userRepo.save(owner);

    // Seed the org's default work-timing policy so a policy governs every
    // employee's clock-in from day one — attendance sits behind policy, and a
    // required work-timing policy must apply to every employee. Best-effort.
    await this.policies
      .seedDefaultWorkTiming(org.id, createdByUserId)
      .catch((e) =>
        this.logger.warn(`Default policy seed failed for ${org.id}: ${e?.message ?? e}`),
      );

    this.logger.log(
      `Org '${org.name}' (${org.id}) provisioned by ${createdByUserId}, owner ${owner.email}`,
    );

    // Invite the owner to sign in and set the org up.
    await this.sendOwnerInvite(org, owner);

    return {
      organization: this.toPublic(org),
      owner: { id: owner.id, email: owner.email },
    };
  }

  /**
   * Email the org's owner an invitation to sign in and set the org up. send()
   * never throws, so a mail hiccup doesn't fail the caller. Returns whether it
   * was accepted for delivery.
   */
  private async sendOwnerInvite(
    org: OrganizationEntity,
    owner: UserEntity,
  ): Promise<boolean> {
    const ownerName = [owner.firstName, owner.lastName]
      .filter((p) => p && p !== 'Owner' && p !== 'Pending')
      .join(' ')
      .trim();
    const invite = orgInviteEmail({
      orgName: org.name,
      ownerName: ownerName || undefined,
      ownerEmail: owner.email,
      loginUrl: `${this.frontendUrl()}/login`,
    });
    return this.mail.send({
      to: { email: owner.email, name: ownerName || undefined },
      subject: invite.subject,
      html: invite.html,
      category: 'org-invite',
      organizationId: org.id,
    });
  }

  /** Re-send the owner invitation email (super admin action). */
  async resendInvite(
    orgId: string,
    actedBy: string,
  ): Promise<{ sent: boolean; email: string }> {
    const org = await this.getEntity(orgId);
    if (!org.ownerId) {
      throw new BadRequestException('This organization has no owner to invite');
    }
    const owner = await this.userRepo.findOne({ where: { id: org.ownerId } });
    if (!owner) {
      throw new NotFoundException('Owner account not found');
    }
    const sent = await this.sendOwnerInvite(org, owner);
    this.logger.log(
      `Invitation re-sent for org ${org.id} to ${owner.email} by ${actedBy}`,
    );
    return { sent, email: owner.email };
  }

  async list(): Promise<OrgPublic[]> {
    const rows = await this.orgRepo.find({
      where: { deletedAt: null as any },
      order: { createdAt: 'DESC' },
    });
    return rows.map((o) => this.toPublic(o));
  }

  async get(id: string): Promise<OrgPublic> {
    return this.toPublic(await this.getEntity(id));
  }

  /**
   * Platform-operator INSIGHTS for one org — account status, the owner contact,
   * seat usage, the org's aggregate auth/security posture, and setup/activity.
   * Same privacy boundary as the platform overview: NO tenant business data
   * (payroll/leave/policies/attendance/HR content), only account-level signals.
   */
  async getInsights(id: string) {
    const org = await this.getEntity(id);
    const pub = this.toPublic(org);
    const now = new Date();

    const memberships = await this.membershipRepo.find({ where: { organizationId: id } });
    const active = memberships.filter((m) => m.status === 'active');
    const invited = memberships.filter((m) => m.status !== 'active');
    const userIds = [...new Set(memberships.map((m) => m.userId).filter((x): x is string => !!x))];
    const users = userIds.length ? await this.userRepo.find({ where: { id: In(userIds) } }) : [];
    const byId = new Map(users.map((u) => [u.id, u]));

    const mfaEnabled = users.filter((u) => u.mfaEnabled).length;
    const verified = users.filter((u) => u.isEmailVerified).length;
    const everLoggedIn = users.filter((u) => !!u.lastLogin).length;
    const lastLoginAt = users.reduce<Date | null>(
      (max, u) => (u.lastLogin && (!max || u.lastLogin > max) ? u.lastLogin : max),
      null,
    );
    const activeSessions = userIds.length
      ? await this.sessionRepo.count({
          where: { userId: In(userIds), isRevoked: false, expiresAt: MoreThan(now) },
        })
      : 0;

    const ownerMembership = active.find((m) => (m.role || '').toLowerCase() === 'owner') || active[0];
    const ownerUser = ownerMembership?.userId ? byId.get(ownerMembership.userId) : undefined;
    const owner = ownerUser
      ? {
          name: `${ownerUser.firstName ?? ''} ${ownerUser.lastName ?? ''}`.trim() || ownerUser.email,
          email: ownerUser.email,
          lastLogin: ownerUser.lastLogin ?? null,
        }
      : null;

    const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);
    const seatBase = active.length || users.length;
    const ageDays = Math.max(0, Math.floor((now.getTime() - org.createdAt.getTime()) / 86_400_000));

    // Structure (org composition — counts + role mix, no HR content).
    const [departments, roles] = await Promise.all([
      this.departmentRepo.count({ where: { organizationId: id } }),
      this.roleRepo.count({ where: { organizationId: id } }),
    ]);
    const roleMix = new Map<string, number>();
    for (const m of active) {
      const r = (m.role || 'member').toLowerCase();
      roleMix.set(r, (roleMix.get(r) || 0) + 1);
    }
    const membersByRole = [...roleMix.entries()]
      .map(([role, count]) => ({ role, count }))
      .sort((a, b) => b.count - a.count);

    // Profile — the owner's setup-wizard workspace config (safe, self-reported).
    const s = (org.settings || {}) as Record<string, unknown>;
    const str = (k: string) => (typeof s[k] === 'string' ? (s[k] as string) : null);
    const profile = {
      industry: str('industry'),
      size: str('size'),
      website: str('website'),
      timezone: str('timezone'),
      currency: str('currency'),
      workModel: str('workModel'),
    };

    return {
      organization: {
        id: org.id,
        name: org.name,
        slug: org.slug,
        status: org.status,
        lifecycle: pub.lifecycle,
        createdAt: org.createdAt,
        ageDays,
      },
      profile,
      structure: { departments, roles, membersByRole },
      setup: { onboardingStep: org.onboardingStep, onboardingCompleted: org.onboardingCompleted },
      consent: {
        accepted: pub.consentAccepted,
        version: pub.consentVersion,
        acceptedAt: pub.consentAcceptedAt,
        currentVersion: pub.currentTermsVersion,
        needsConsent: pub.needsConsent,
      },
      owner,
      people: {
        members: memberships.length,
        active: active.length,
        invited: invited.length,
        mfaEnabled,
        mfaAdoption: pct(mfaEnabled, seatBase),
        verified,
        verifiedPct: pct(verified, users.length),
        everLoggedIn,
        dormant: Math.max(0, users.length - everLoggedIn),
        activeSessions,
      },
      activity: { lastLoginAt, createdAt: org.createdAt, ageDays },
    };
  }

  // ── Consent (owner) ──────────────────────────────────────────────────────

  /** The active T&C id (for streaming its PDF on the consent screen). */
  async getAssignedTermsId(_orgId: string): Promise<string | null> {
    return this.terms.getActive()?.id ?? null;
  }

  /** The consent state + the active platform T&C for the owner's consent screen. */
  async getConsentState(orgId: string) {
    const org = await this.getEntity(orgId);
    const doc = await this.terms.getActiveForConsent();
    return {
      organization: { id: org.id, name: org.name, status: org.status },
      terms: doc
        ? {
            id: doc.id,
            version: doc.version,
            kind: doc.kind,
            text: doc.text,
            title: doc.title,
            hasDocument: doc.kind === 'pdf' && !!doc.fileId,
          }
        : null,
      accepted: !this.needsConsent(org),
      acceptedVersion: org.consent?.version ?? null,
      acceptedAt: org.consent?.acceptedAt ?? null,
      needsConsent: this.needsConsent(org),
    };
  }

  /** Record the owner's acceptance of the ACTIVE platform T&C at its version. */
  async acceptConsent(
    orgId: string,
    userId: string,
    ip?: string,
    ua?: string,
  ): Promise<OrgPublic> {
    const org = await this.getEntity(orgId);
    const active = this.terms.getActive();
    if (!active) {
      throw new BadRequestException('No active Terms & Conditions to accept');
    }
    const doc = await this.terms.get(active.id);
    org.consent = {
      termsId: doc.id,
      version: doc.version,
      acceptedByUserId: userId,
      acceptedAt: new Date().toISOString(),
      ipAddress: ip ?? null,
      userAgent: ua ?? null,
    };
    await this.orgRepo.save(org);
    this.logger.log(
      `Org ${org.id} accepted Terms ${doc.id} v${doc.version} (user ${userId})`,
    );
    return this.toPublic(org);
  }

  // ── Setup wizard (owner) ─────────────────────────────────────────────────

  /** The org profile + wizard progress for the owner's setup wizard. */
  async getOnboardingState(orgId: string) {
    const org = await this.getEntity(orgId);
    return {
      organizationId: org.id,
      name: org.name,
      slug: org.slug,
      settings: org.settings || {},
      onboardingStep: org.onboardingStep ?? 0,
      onboardingCompleted: !!org.onboardingCompleted,
    };
  }

  /** Update the org name and/or merge workspace settings (wizard steps 1–2). */
  async updateProfile(
    orgId: string,
    input: { name?: string; settings?: Record<string, unknown> },
  ) {
    const org = await this.getEntity(orgId);
    if (input.name && input.name.trim()) org.name = input.name.trim();
    if (input.settings && typeof input.settings === 'object') {
      org.settings = { ...(org.settings || {}), ...input.settings };
    }
    await this.orgRepo.save(org);
    return this.getOnboardingState(orgId);
  }

  /** Advance the wizard step / mark it complete. */
  async updateOnboarding(
    orgId: string,
    input: { step?: number; completed?: boolean },
  ) {
    const org = await this.getEntity(orgId);
    if (typeof input.step === 'number') org.onboardingStep = input.step;
    if (typeof input.completed === 'boolean') {
      org.onboardingCompleted = input.completed;
    }
    await this.orgRepo.save(org);
    return this.getOnboardingState(orgId);
  }

  // ── Halt / reactivate (super admin) ──────────────────────────────────────

  async halt(orgId: string, actedBy: string): Promise<OrgPublic> {
    const org = await this.getEntity(orgId);
    org.status = 'suspended';
    await this.orgRepo.save(org);
    this.logger.log(`Org ${org.id} HALTED by ${actedBy}`);
    return this.toPublic(org);
  }

  async reactivate(orgId: string, actedBy: string): Promise<OrgPublic> {
    const org = await this.getEntity(orgId);
    org.status = 'active';
    await this.orgRepo.save(org);
    this.logger.log(`Org ${org.id} reactivated by ${actedBy}`);
    return this.toPublic(org);
  }
}
