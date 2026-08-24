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
import { CreateOrganizationDto } from '../dto';

export interface OrgPublic {
  id: string;
  name: string;
  slug: string;
  status: string;
  ownerId: string | null;
  createdAt: Date;
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
  ) {}

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
    return {
      id: o.id,
      name: o.name,
      slug: o.slug,
      status: o.status,
      ownerId: o.ownerId,
      createdAt: o.createdAt,
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
    // Provisioned orgs start in `onboarding` — the owner can sign in but is
    // confined to the document-submission surface until a super admin approves
    // every requested document, at which point the org flips to `active`.
    const org = await this.orgRepo.save(
      this.orgRepo.create({
        name: dto.name.trim(),
        slug,
        status: 'onboarding',
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
    const org = await this.orgRepo.findOne({ where: { id } });
    if (!org) throw new NotFoundException('Organization not found');
    return this.toPublic(org);
  }
}
