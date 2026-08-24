import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';

import { OrganizationEntity } from '../entities/organization.entity';
import { UserEntity } from '../../auth/entities/user.entity';
import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';
import { TermsService } from '../../terms/terms.service';
import { CreateOrganizationDto } from '../dto';

export interface OrgPublic {
  id: string;
  name: string;
  slug: string;
  status: string; // active | suspended
  ownerId: string | null;
  createdAt: Date;
  /** Whether the org has accepted the CURRENT T&C version. */
  consentAccepted: boolean;
  /** True when consent is missing or stale (must (re-)accept). */
  needsConsent: boolean;
  consentVersion: number | null;
  consentAcceptedAt: string | null;
  currentTermsVersion: number;
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
    private readonly terms: TermsService,
  ) {}

  /** True when the org has not accepted the CURRENT T&C version. */
  needsConsent(o: OrganizationEntity): boolean {
    return !o.consent || o.consent.version < this.terms.getCurrentVersion();
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
    const currentTermsVersion = this.terms.getCurrentVersion();
    const needsConsent = this.needsConsent(o);
    return {
      id: o.id,
      name: o.name,
      slug: o.slug,
      status: o.status,
      ownerId: o.ownerId,
      createdAt: o.createdAt,
      consentAccepted: !needsConsent,
      needsConsent,
      consentVersion: o.consent?.version ?? null,
      consentAcceptedAt: o.consent?.acceptedAt ?? null,
      currentTermsVersion,
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

    const slug = await this.uniqueSlug(dto.name);
    // Provisioned orgs are `active` with NO consent yet — the owner can sign in
    // but is routed to the consent screen and blocked from the app until they
    // accept the current Terms & Conditions. `suspended` is a manual halt.
    const org = await this.orgRepo.save(
      this.orgRepo.create({
        name: dto.name.trim(),
        slug,
        status: 'active',
        consent: null,
        ownerId: owner.id,
        createdBy: createdByUserId,
      }),
    );

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

    this.logger.log(
      `Org '${org.name}' (${org.id}) provisioned by ${createdByUserId}, owner ${owner.email}`,
    );

    return {
      organization: this.toPublic(org),
      owner: { id: owner.id, email: owner.email },
    };
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

  // ── Consent (owner) ──────────────────────────────────────────────────────

  /** The consent state + current T&C text for the owner's consent screen. */
  async getConsentState(orgId: string) {
    const org = await this.getEntity(orgId);
    const current = await this.terms.getCurrent();
    return {
      organization: { id: org.id, name: org.name, status: org.status },
      terms: { version: current.version, text: current.text },
      accepted: !this.needsConsent(org),
      acceptedVersion: org.consent?.version ?? null,
      acceptedAt: org.consent?.acceptedAt ?? null,
      needsConsent: this.needsConsent(org),
    };
  }

  /** Record the owner's acceptance of the CURRENT T&C version. */
  async acceptConsent(
    orgId: string,
    userId: string,
    ip?: string,
    ua?: string,
  ): Promise<OrgPublic> {
    const org = await this.getEntity(orgId);
    const current = await this.terms.getCurrent();
    org.consent = {
      version: current.version,
      acceptedByUserId: userId,
      acceptedAt: new Date().toISOString(),
      ipAddress: ip ?? null,
      userAgent: ua ?? null,
    };
    await this.orgRepo.save(org);
    this.logger.log(
      `Org ${org.id} accepted Terms v${current.version} (user ${userId})`,
    );
    return this.toPublic(org);
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
