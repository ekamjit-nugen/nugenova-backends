import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { RoleEntity } from '../auth/entities/role.entity';
import { OrganizationEntity } from '../organization/entities/organization.entity';
import { OrgNotificationSettingEntity } from './entities/org-notification-setting.entity';
import { EMAIL_CATALOG, EmailKind, emailCatalogEntry, emailKind } from './email-catalog';

/** Audience keys — the columns of the Roles page email matrix. */
export const AUDIENCE_OWNER = 'tier:owner';
export const AUDIENCE_ADMIN = 'tier:admin';
/** Members with no custom role (and not an owner/admin). */
export const AUDIENCE_NO_ROLE = 'norole';
export const roleAudience = (roleId: string) => `role:${roleId}`;

/** What a column means before anyone changes it. */
export function defaultEnabled(kind: EmailKind, audience: string): boolean {
  if (kind === 'team') return audience === AUDIENCE_OWNER || audience === AUDIENCE_ADMIN;
  return true; // personal: everyone gets their own; fixed: always sent
}

/** The audiences a membership belongs to — a member receives if ANY is enabled. */
export function audiencesOf(m: Pick<OrgMembershipEntity, 'role' | 'roleId' | 'secondaryRoleId'>): string[] {
  const out: string[] = [];
  if (m.role === 'owner') out.push(AUDIENCE_OWNER);
  if (m.role === 'admin') out.push(AUDIENCE_ADMIN);
  const roleIds = [m.roleId, m.secondaryRoleId].filter(Boolean) as string[];
  for (const id of roleIds) out.push(roleAudience(id));
  if (!roleIds.length && m.role !== 'owner' && m.role !== 'admin') out.push(AUDIENCE_NO_ROLE);
  return out;
}

/**
 * One org's email routing, loaded once. Crons that email many people build one of
 * these per org instead of querying per recipient.
 */
export class OrgEmailRouting {
  constructor(
    private readonly overrides: Record<string, Record<string, boolean>>,
    private readonly members: OrgMembershipEntity[],
  ) {}

  /** Is `audience` ticked for `key`? */
  enabled(key: string, audience: string): boolean {
    const kind = emailKind(key);
    if (!kind || kind === 'fixed') return true;
    const set = this.overrides[key]?.[audience];
    return set !== undefined ? set : defaultEnabled(kind, audience);
  }

  /**
   * May this member receive email `key`? Only STAFF are routed by role: client
   * portal users, students and guardians hold no staff role, so role choices
   * don't apply to them. Unknown keys and fixed emails always pass — routing must
   * never silently drop an email nobody configured.
   */
  allowsMember(key: string, m: OrgMembershipEntity): boolean {
    const kind = emailKind(key);
    if (!kind || kind === 'fixed') return true;
    if (m.role === 'client' || (m.personType && m.personType !== 'staff')) return true;
    return audiencesOf(m).some((a) => this.enabled(key, a));
  }

  /** May this user receive `key`? Someone with no active membership here isn't routed. */
  allowsUser(key: string, userId: string): boolean {
    const m = this.members.find((x) => x.userId === userId);
    return m ? this.allowsMember(key, m) : true;
  }

  /** Everyone who should receive a TEAM email: active staff in a ticked audience. */
  teamRecipients(key: string): string[] {
    return this.members
      .filter((m) => m.userId && m.role !== 'client' && (!m.personType || m.personType === 'staff'))
      .filter((m) => audiencesOf(m).some((a) => this.enabled(key, a)))
      .map((m) => m.userId as string);
  }
}

export interface EmailMatrixView {
  audiences: Array<{ key: string; label: string; kind: 'tier' | 'role' | 'norole' }>;
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

  /** The Roles page matrix: every email × every audience, with effective ticks. */
  async matrix(orgId: string): Promise<EmailMatrixView> {
    const [row, roles] = await Promise.all([
      this.settings.findOne({ where: { organizationId: orgId } }),
      this.roles.find({ where: { organizationId: orgId, isDeleted: false }, order: { displayName: 'ASC' } }),
    ]);
    const routing = new OrgEmailRouting(row?.emailRouting ?? {}, []);
    const audiences: EmailMatrixView['audiences'] = [
      { key: AUDIENCE_OWNER, label: 'Owner', kind: 'tier' },
      { key: AUDIENCE_ADMIN, label: 'Admin', kind: 'tier' },
      ...roles.map((r) => ({ key: roleAudience(r.id), label: r.displayName || r.name, kind: 'role' as const })),
      { key: AUDIENCE_NO_ROLE, label: 'No custom role', kind: 'norole' },
    ];
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

  /** Tick or untick one audience for one email. */
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
    if (enabled === defaultEnabled(entry.kind, audience)) delete forKey[audience];
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
    if (audience === AUDIENCE_OWNER || audience === AUDIENCE_ADMIN || audience === AUDIENCE_NO_ROLE) return;
    const match = /^role:(.+)$/.exec(audience);
    if (match) {
      const role = await this.roles.findOne({ where: { id: match[1], organizationId: orgId, isDeleted: false } });
      if (role) return;
    }
    throw new BadRequestException(`Unknown audience "${audience}"`);
  }
}
