import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { OrganizationEntity } from '../entities/organization.entity';
import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';
import { staffScope } from '../../auth/entities/person-type';
import { DriveQuotaEntity } from '../../storage/entities/drive-quota.entity';
import { DriveService } from '../../storage/drive.service';
import {
  PlatformSettingsEntity,
  PLATFORM_SETTINGS_ID,
} from '../../admin-platform/entities/platform-settings.entity';

const GB = 1024 * 1024 * 1024;

export interface PlatformDefaults {
  defaultOrgStorageGb: number;
  defaultUserQuotaGb: number;
  defaultMaxMembers: number | null;
}

export interface OrgLimitsView {
  storage: {
    teamQuotaGb: number;
    defaultUserQuotaGb: number;
    usedBytes: number;
    usedPercent: number;
  };
  members: {
    count: number;
    /** Effective cap (override ?? platform default). null = unlimited. */
    maxMembers: number | null;
    /** The per-org override as stored (null = inheriting the platform default). */
    override: number | null;
    unlimited: boolean;
  };
}

/**
 * OrgLimitsService — the super admin's control plane for per-org allocation:
 * storage (Team-Drive pool + default per-user My-Drive) and the member seat cap.
 *
 * Two layers:
 *   - PLATFORM DEFAULTS (`platform_settings`, singleton) — applied to a new org
 *     at provisioning and the fallback for any org with no explicit override.
 *   - PER-ORG OVERRIDES — storage writes `drive_quotas` (the physical quota the
 *     drive already enforces); the seat cap writes `organizations.limits`.
 *
 * Seat counting uses `staffScope` so the owner + staff members count against the
 * cap and students/guardians never do.
 */
@Injectable()
export class OrgLimitsService {
  private readonly log = new Logger(OrgLimitsService.name);

  constructor(
    @InjectRepository(OrganizationEntity)
    private readonly orgs: Repository<OrganizationEntity>,
    @InjectRepository(OrgMembershipEntity)
    private readonly memberships: Repository<OrgMembershipEntity>,
    @InjectRepository(PlatformSettingsEntity)
    private readonly settingsRepo: Repository<PlatformSettingsEntity>,
    @InjectRepository(DriveQuotaEntity)
    private readonly quotas: Repository<DriveQuotaEntity>,
    private readonly drive: DriveService,
  ) {}

  // ─── Platform defaults (singleton) ───────────────────────────────

  private async settingsRow(): Promise<PlatformSettingsEntity> {
    let row = await this.settingsRepo.findOne({ where: { id: PLATFORM_SETTINGS_ID } });
    if (!row) {
      // Defensive: the migration seeds this, but never assume it's there.
      row = await this.settingsRepo.save(
        this.settingsRepo.create({
          id: PLATFORM_SETTINGS_ID,
          defaultOrgStorageGb: 50,
          defaultUserQuotaGb: 1,
          defaultMaxMembers: null,
        }),
      );
    }
    return row;
  }

  async getPlatformDefaults(): Promise<PlatformDefaults> {
    const r = await this.settingsRow();
    return {
      defaultOrgStorageGb: r.defaultOrgStorageGb,
      defaultUserQuotaGb: r.defaultUserQuotaGb,
      defaultMaxMembers: r.defaultMaxMembers,
    };
  }

  async setPlatformDefaults(
    dto: {
      defaultOrgStorageGb?: number;
      defaultUserQuotaGb?: number;
      defaultMaxMembers?: number | null;
    },
    actorId: string,
  ): Promise<PlatformDefaults> {
    const row = await this.settingsRow();
    if (typeof dto.defaultOrgStorageGb === 'number')
      row.defaultOrgStorageGb = dto.defaultOrgStorageGb;
    if (typeof dto.defaultUserQuotaGb === 'number')
      row.defaultUserQuotaGb = dto.defaultUserQuotaGb;
    if (dto.defaultMaxMembers !== undefined)
      row.defaultMaxMembers = dto.defaultMaxMembers;
    row.updatedBy = actorId;
    await this.settingsRepo.save(row);
    return this.getPlatformDefaults();
  }

  // ─── Per-org limits ──────────────────────────────────────────────

  /** Owner + staff members that count against the seat cap. */
  async countMembers(organizationId: string): Promise<number> {
    return this.memberships.count({ where: staffScope({ organizationId }) });
  }

  private effectiveMaxMembers(
    org: OrganizationEntity,
    defaults: PlatformDefaults,
  ): number | null {
    const override = org.limits?.maxMembers;
    return typeof override === 'number' ? override : defaults.defaultMaxMembers;
  }

  async getOrgLimits(organizationId: string): Promise<OrgLimitsView> {
    const org = await this.orgs.findOne({ where: { id: organizationId } });
    if (!org) throw new NotFoundException('Organization not found');
    const defaults = await this.getPlatformDefaults();

    const teamRow = await this.quotas.findOne({
      where: { organizationId, ownerId: IsNull() },
    });
    const teamQuotaGb = teamRow?.limitBytes
      ? Math.round(Number(teamRow.limitBytes) / GB)
      : defaults.defaultOrgStorageGb;
    const defaultUserQuotaGb = teamRow?.defaultUserLimitBytes
      ? Math.round(Number(teamRow.defaultUserLimitBytes) / GB)
      : defaults.defaultUserQuotaGb;

    const usedBytes = (await this.drive.getQuota(organizationId)).usedBytes;
    const quotaBytes = teamQuotaGb * GB;
    const usedPercent = quotaBytes
      ? Math.min(100, (usedBytes / quotaBytes) * 100)
      : 0;

    const count = await this.countMembers(organizationId);
    const maxMembers = this.effectiveMaxMembers(org, defaults);
    const override = typeof org.limits?.maxMembers === 'number' ? org.limits!.maxMembers! : null;

    return {
      storage: { teamQuotaGb, defaultUserQuotaGb, usedBytes, usedPercent },
      members: { count, maxMembers, override, unlimited: maxMembers === null },
    };
  }

  async setOrgLimits(
    organizationId: string,
    dto: {
      teamQuotaGb?: number;
      defaultUserQuotaGb?: number;
      maxMembers?: number | null;
    },
    _actorId: string,
  ): Promise<OrgLimitsView> {
    const org = await this.orgs.findOne({ where: { id: organizationId } });
    if (!org) throw new NotFoundException('Organization not found');

    if (dto.teamQuotaGb !== undefined || dto.defaultUserQuotaGb !== undefined) {
      await this.drive.setOrgStorageSettings(organizationId, {
        quotaGb: dto.teamQuotaGb,
        defaultUserQuotaGb: dto.defaultUserQuotaGb,
      });
    }
    // `maxMembers` present (including null) → set/clear the per-org override.
    if (Object.prototype.hasOwnProperty.call(dto, 'maxMembers')) {
      org.limits = { ...(org.limits || {}), maxMembers: dto.maxMembers ?? null };
      await this.orgs.save(org);
    }
    return this.getOrgLimits(organizationId);
  }

  /**
   * Enforce the seat cap BEFORE a new member is inserted. No-op when the org is
   * unlimited. Throws 403 SEAT_LIMIT_REACHED when the org is already at capacity.
   */
  async assertSeatAvailable(organizationId: string): Promise<void> {
    const org = await this.orgs.findOne({ where: { id: organizationId } });
    if (!org) return; // defensive — real add paths always have a real org
    const defaults = await this.getPlatformDefaults();
    const max = this.effectiveMaxMembers(org, defaults);
    if (max === null) return; // unlimited
    const count = await this.countMembers(organizationId);
    if (count >= max) {
      throw new ForbiddenException({
        code: 'SEAT_LIMIT_REACHED',
        message:
          `This organization has reached its member limit (${max}). ` +
          `Ask a platform admin to raise the seat allocation.`,
        maxMembers: max,
        currentMembers: count,
      });
    }
  }

  /**
   * Seed a newly provisioned org's storage allocation from the platform defaults
   * so it reflects the super admin's chosen defaults from day one. The seat cap
   * is left inheriting the default (no per-org override written).
   */
  async provisionNewOrg(organizationId: string): Promise<void> {
    const defaults = await this.getPlatformDefaults();
    try {
      await this.drive.setOrgStorageSettings(organizationId, {
        quotaGb: defaults.defaultOrgStorageGb,
        defaultUserQuotaGb: defaults.defaultUserQuotaGb,
      });
    } catch (err) {
      // Provisioning storage defaults must never block org creation.
      this.log.warn(
        `provisionNewOrg(${organizationId}) storage seed failed: ${(err as Error)?.message}`,
      );
    }
  }
}
