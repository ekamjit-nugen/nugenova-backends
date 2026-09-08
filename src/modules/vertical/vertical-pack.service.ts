import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { OrganizationEntity } from '../organization/entities/organization.entity';
import { RoleEntity } from '../auth/entities/role.entity';
import {
  EDUCATION_ROLES,
  EDUCATION_ROLE_NAMES,
} from '../organization/default-roles';
import {
  AI_TIER_MAX,
  AI_TIER_MIN,
  DEFAULT_VERTICAL_PACKS,
  OrgType,
  ORG_TYPES,
  VerticalPack,
  defaultPackFor,
  isOrgType,
} from './vertical-packs';
import { SetVerticalPackDto } from './dto';

/** The resolved, effective pack returned to a caller (default merged w/ override). */
export interface ResolvedVerticalPack {
  organizationId: string;
  orgType: OrgType;
  vocabulary: Record<string, string>;
  enabledModules: string[];
  aiTierCeiling: number;
  /** Whether any per-org override is applied on top of the orgType default. */
  hasOverride: boolean;
}

/**
 * VerticalPackService — §04/§12. The vertical is a CONFIG object, not a fork:
 * this service resolves the EFFECTIVE pack for an org (the orgType default deep-
 * merged with the org's per-org override), and answers the three questions the
 * rest of the platform asks of a pack:
 *
 *  - what VOCABULARY should the UI render for this org,
 *  - is a given MODULE enabled for it,
 *  - what is its AI tier CEILING (0–3, §09).
 *
 * It also owns the admin mutation (`setPack`) and seeds the education role set
 * when an org becomes an education vertical (reusing the org role matrix; the
 * matrix engine itself is untouched).
 */
@Injectable()
export class VerticalPackService {
  private readonly logger = new Logger(VerticalPackService.name);

  constructor(
    @InjectRepository(OrganizationEntity)
    private readonly orgs: Repository<OrganizationEntity>,
    @InjectRepository(RoleEntity)
    private readonly roles: Repository<RoleEntity>,
  ) {}

  /** Resolve the effective pack for an org (throws 404 if the org is unknown). */
  async resolvePack(orgId: string): Promise<ResolvedVerticalPack> {
    const org = await this.requireOrg(orgId);
    return this.resolveForOrg(org);
  }

  /** Pure resolver: merge an org's override over its orgType default pack. */
  resolveForOrg(org: OrganizationEntity): ResolvedVerticalPack {
    const orgType: OrgType = isOrgType(org.orgType) ? org.orgType : 'company';
    const base = defaultPackFor(orgType);
    const override = org.verticalPack ?? null;

    const vocabulary = { ...base.vocabulary, ...(override?.vocabulary ?? {}) };
    const enabledModules =
      override?.enabledModules && override.enabledModules.length
        ? [...new Set(override.enabledModules)]
        : [...base.enabledModules];
    // An override may only LOWER the ceiling, never raise it above the vertical's
    // default (a school can't grant itself tier 3 by editing its own pack).
    const aiTierCeiling =
      override?.aiTierCeiling !== undefined
        ? Math.min(override.aiTierCeiling, base.aiTierCeiling)
        : base.aiTierCeiling;

    return {
      organizationId: org.id,
      orgType,
      vocabulary,
      enabledModules,
      aiTierCeiling,
      hasOverride: !!override,
    };
  }

  /** Is `moduleKey` enabled for this org? */
  async isModuleEnabled(orgId: string, moduleKey: string): Promise<boolean> {
    const pack = await this.resolvePack(orgId);
    return pack.enabledModules.includes(moduleKey);
  }

  /** The org's AI tier ceiling (0–3). */
  async aiTierCeiling(orgId: string): Promise<number> {
    return (await this.resolvePack(orgId)).aiTierCeiling;
  }

  /**
   * Admin mutation — set the org's `orgType` and/or per-org pack override.
   * Switching to an education orgType seeds the education role set (idempotent).
   */
  async setPack(
    orgId: string,
    dto: SetVerticalPackDto,
    actorId: string,
  ): Promise<ResolvedVerticalPack> {
    const org = await this.requireOrg(orgId);

    if (dto.orgType !== undefined) {
      if (!isOrgType(dto.orgType)) {
        throw new BadRequestException(
          `orgType must be one of: ${ORG_TYPES.join(', ')}`,
        );
      }
      org.orgType = dto.orgType;
    }

    if (dto.verticalPack !== undefined) {
      org.verticalPack = this.sanitiseOverride(
        org.orgType,
        dto.verticalPack ?? null,
      );
    }

    await this.orgs.save(org);

    const resolved = this.resolveForOrg(org);
    // When the org is (now) an education vertical, make its role set available.
    if (resolved.orgType !== 'company') {
      await this.seedEducationRoles(orgId, actorId);
    }
    this.logger.log(
      `Vertical pack for org ${orgId} set to '${resolved.orgType}' by ${actorId}`,
    );
    return resolved;
  }

  /**
   * Seed the education system roles for an org — idempotent, mirrors
   * OrgRoleService.seedDefaults. Reuses the RoleEntity matrix mechanism; the
   * matrix engine is untouched. Skips any role name already present.
   */
  async seedEducationRoles(
    orgId: string,
    createdBy: string,
  ): Promise<RoleEntity[]> {
    const existing = await this.roles.find({
      where: { organizationId: orgId, isDeleted: false },
    });
    const have = new Set(existing.map((r) => r.name));
    const toCreate = EDUCATION_ROLES.filter((r) => !have.has(r.name)).map((r) =>
      this.roles.create({
        organizationId: orgId,
        name: r.name,
        displayName: r.displayName,
        description: r.description,
        departmentId: null,
        tier: r.tier,
        isSystem: true,
        permissions: r.permissions,
        createdBy,
      }),
    );
    if (toCreate.length) {
      await this.roles.save(toCreate);
      this.logger.log(
        `Seeded ${toCreate.length} education role(s) for org ${orgId}`,
      );
    }
    return this.roles.find({
      where: { organizationId: orgId, isDeleted: false },
      order: { createdAt: 'ASC' },
    });
  }

  /** Whether a role name belongs to the education role set. */
  isEducationRole(name: string): boolean {
    return EDUCATION_ROLE_NAMES.has(name);
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  private async requireOrg(orgId: string): Promise<OrganizationEntity> {
    const org = await this.orgs.findOne({ where: { id: orgId } });
    if (!org) throw new NotFoundException('Organization not found');
    return org;
  }

  /** Validate + clamp an override so it can never widen beyond the vertical default. */
  private sanitiseOverride(
    orgType: string,
    override: SetVerticalPackDto['verticalPack'],
  ): OrganizationEntity['verticalPack'] {
    if (!override) return null;
    const base: VerticalPack =
      DEFAULT_VERTICAL_PACKS[isOrgType(orgType) ? orgType : 'company'];
    const clean: NonNullable<OrganizationEntity['verticalPack']> = {};

    if (override.vocabulary !== undefined) clean.vocabulary = override.vocabulary;
    if (override.enabledModules !== undefined)
      clean.enabledModules = [...new Set(override.enabledModules)];
    if (override.aiTierCeiling !== undefined) {
      const t = override.aiTierCeiling;
      if (t < AI_TIER_MIN || t > AI_TIER_MAX || !Number.isInteger(t)) {
        throw new BadRequestException(
          `aiTierCeiling must be an integer between ${AI_TIER_MIN} and ${AI_TIER_MAX}`,
        );
      }
      // An override may only lower, never raise, the vertical's own ceiling.
      clean.aiTierCeiling = Math.min(t, base.aiTierCeiling);
    }
    return Object.keys(clean).length ? clean : null;
  }
}
