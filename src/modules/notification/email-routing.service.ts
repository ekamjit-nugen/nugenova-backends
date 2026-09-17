import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { RoleEntity } from '../auth/entities/role.entity';
import { OrganizationEntity } from '../organization/entities/organization.entity';
import { OrgNotificationSettingEntity } from './entities/org-notification-setting.entity';
import { EMAIL_CATALOG, EmailKind, emailCatalogEntry, emailKind } from './email-catalog';

/**
 * Audience keys — the columns of the email matrix. They are exactly the columns of
 * the permission matrix: the org's roles. Owners and admins are not columns there
 * (they have every permission) and are not columns here (they receive every email).
 */
export const roleAudience = (roleId: string) => `role:${roleId}`;

/** What a role column means before anyone changes it. */
export function defaultEnabled(kind: EmailKind): boolean {
  // team: only owners and admins until a role is ticked; personal: everyone gets
  // their own; fixed: always sent.
  return kind !== 'team';
}

type RoutedMember = Pick<OrgMembershipEntity, 'role' | 'roleId' | 'secondaryRoleId' | 'personType'>;

/** The role columns a membership belongs to — a member receives if ANY is ticked. */
export function audiencesOf(m: Pick<OrgMembershipEntity, 'roleId' | 'secondaryRoleId'>): string[] {
  return ([m.roleId, m.secondaryRoleId].filter(Boolean) as string[]).map(roleAudience);
}

/** Owners and admins receive every email, just as they hold every permission. */
const isOwnerOrAdmin = (m: Pick<OrgMembershipEntity, 'role'>) => m.role === 'owner' || m.role === 'admin';

/** Client portal users, students and guardians hold no staff role; role choices don't apply to them. */
const isStaff = (m: Pick<OrgMembershipEntity, 'role' | 'personType'>) =>
  m.role !== 'client' && (!m.personType || m.personType === 'staff');

/**
 * One org's email routing, loaded once. Crons that email many people build one of
 * these per org instead of querying per recipient.
 *
 * Stored choices for keys that are no longer columns (the earlier `tier:owner`,
 * `tier:admin` and `norole`) are ignored.
 */
export class OrgEmailRouting {
  constructor(
    private readonly overrides: Record<string, Record<string, boolean>>,
    private readonly members: OrgMembershipEntity[],
  ) {}

  /** Is the role column `audience` ticked for `key`? */
  enabled(key: string, audience: string): boolean {
    const kind = emailKind(key);
    if (!kind || kind === 'fixed') return true;
    const set = this.overrides[key]?.[audience];
    return set !== undefined ? set : defaultEnabled(kind);
  }

  /**
   * May this member receive email `key`? Unknown keys and fixed emails always
   * pass — routing must never silently drop an email nobody configured.
   *
   * - owners and admins: always;
   * - non-staff (client portal, students, guardians): always — not routed by role;
   * - staff with roles: if any of their roles is ticked;
   * - staff with no role: personal emails yes, team emails no.
   */
  allowsMember(key: string, m: RoutedMember): boolean {
    const kind = emailKind(key);
    if (!kind || kind === 'fixed') return true;
    if (isOwnerOrAdmin(m) || !isStaff(m)) return true;
    const audiences = audiencesOf(m);
    if (!audiences.length) return kind === 'personal';
    return audiences.some((a) => this.enabled(key, a));
  }

  /** May this user receive `key`? Someone with no active membership here isn't routed. */
  allowsUser(key: string, userId: string): boolean {
    const m = this.members.find((x) => x.userId === userId);
    return m ? this.allowsMember(key, m) : true;
  }

  /** Everyone who should receive a TEAM email: owners, admins, and staff in a ticked role. */
  teamRecipients(key: string): string[] {
    return this.members
      .filter((m) => m.userId && isStaff(m))
      .filter((m) => this.allowsMember(key, m))
      .map((m) => m.userId as string);
  }
}

export interface EmailMatrixView {
  /** The org's roles, in the same order as the permission matrix. */
  audiences: Array<{ key: string; roleId: string; label: string }>;
  emails: Array<{
    key: string;
    label: string;
    group: string;
    kind: EmailKind;
    about: string;
    /** Effective tick per audience (fixed emails: all true, not changeable). */
    routing: Record<string, boolean>;
  }>;
}

/**
 * EmailRoutingService — which roles receive which emails. Replaces "everyone who
 * holds permission X" (which sent the org-wide attendance summary to any role
 * that could view attendance) with an explicit per-role choice, managed on the
 * Roles & Permissions page. Fails OPEN on errors: a broken setting must never
 * stop mail.
 */
@Injectable()
export class EmailRoutingService {
  private readonly logger = new Logger(EmailRoutingService.name);

  constructor(
    @InjectRepository(OrgNotificationSettingEntity)
    private readonly settings: Repository<OrgNotificationSettingEntity>,
    @InjectRepository(OrgMembershipEntity)
    private readonly memberships: Repository<OrgMembershipEntity>,
    @InjectRepository(RoleEntity)
    private readonly roles: Repository<RoleEntity>,
    @InjectRepository(OrganizationEntity)
    private readonly orgs: Repository<OrganizationEntity>,
    private readonly config: ConfigService,
  ) {}

  async forOrg(orgId: string): Promise<OrgEmailRouting> {
    const [row, members] = await Promise.all([
      this.settings.findOne({ where: { organizationId: orgId } }),
      this.memberships.find({ where: { organizationId: orgId, status: 'active' } }),
    ]);
    return new OrgEmailRouting(row?.emailRouting ?? {}, members);
  }

  /** Convenience for a single send. Fails open. */
  async allows(orgId: string, key: string, userId: string): Promise<boolean> {
    const kind = emailKind(key);
    if (!kind || kind === 'fixed') return true;
    try {
      return (await this.forOrg(orgId)).allowsUser(key, userId);
    } catch (err) {
      this.logger.error(`allows(${key}) failed for ${orgId}: ${String(err)}`);
      return true;
    }
  }

  /** The email matrix: every email × every role, with effective ticks. */
  async matrix(orgId: string): Promise<EmailMatrixView> {
    const [row, roles] = await Promise.all([
      this.settings.findOne({ where: { organizationId: orgId } }),
      this.roles.find({ where: { organizationId: orgId, isDeleted: false }, order: { createdAt: 'ASC' } }),
    ]);
    const routing = new OrgEmailRouting(row?.emailRouting ?? {}, []);
    // Same roles, same order as GET /org/roles (the permission matrix).
    const audiences: EmailMatrixView['audiences'] = roles.map((r) => ({
      key: roleAudience(r.id),
      roleId: r.id,
      label: r.displayName || r.name,
    }));
    return {
      audiences,
      emails: EMAIL_CATALOG.map((e) => ({
        key: e.key,
        label: e.label,
        group: e.group,
        kind: e.kind,
        about: e.about,
        routing: Object.fromEntries(audiences.map((a) => [a.key, routing.enabled(e.key, a.key)])),
      })),
    };
  }

  /** Tick or untick one role for one email. */
  async set(orgId: string, key: string, audience: string, enabled: boolean): Promise<EmailMatrixView> {
    const entry = emailCatalogEntry(key);
    if (!entry) throw new NotFoundException(`Unknown email "${key}"`);
    if (entry.kind === 'fixed') {
      throw new BadRequestException(`"${entry.label}" is always sent and can't be turned off for a role`);
    }
    await this.assertAudience(orgId, audience);

    let row = await this.settings.findOne({ where: { organizationId: orgId } });
    if (!row) row = this.settings.create({ organizationId: orgId, employeeCategories: {}, employeeTypes: {}, emailRouting: {} });
    const next = { ...(row.emailRouting || {}) };
    const forKey = { ...(next[key] || {}) };
    // Store only real choices: a tick that matches the default is removed, so a
    // later change of default still reaches orgs that never touched it.
    if (enabled === defaultEnabled(entry.kind)) delete forKey[audience];
    else forKey[audience] = enabled;
    if (Object.keys(forKey).length) next[key] = forKey;
    else delete next[key];
    row.emailRouting = next;
    await this.settings.save(row);
    return this.matrix(orgId);
  }

  /**
   * Render one email exactly as it's sent, with sample data and this org's name —
   * the same template function the real send calls.
   */
  async preview(orgId: string, key: string): Promise<{ key: string; label: string; subject: string; html: string }> {
    const entry = emailCatalogEntry(key);
    if (!entry) throw new NotFoundException(`Unknown email "${key}"`);
    const org = await this.orgs.findOne({ where: { id: orgId } });
    const { subject, html } = entry.preview({
      orgName: org?.name || 'Your organization',
      frontendUrl: this.config.get<string>('FRONTEND_URL') || 'https://nugenova.com',
    });
    return { key: entry.key, label: entry.label, subject, html };
  }

  private async assertAudience(orgId: string, audience: string): Promise<void> {
    const match = /^role:(.+)$/.exec(audience);
    if (match) {
      const role = await this.roles.findOne({ where: { id: match[1], organizationId: orgId, isDeleted: false } });
      if (role) return;
    }
    throw new BadRequestException(`Unknown role "${audience}"`);
  }
}
