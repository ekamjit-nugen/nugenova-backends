import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { OrgChatSettingEntity, OrgChatSettings } from '../entities/org-chat-setting.entity';
import { OrgMembershipEntity } from '../../auth/entities/org-membership.entity';

/** Permissive defaults — an unconfigured org behaves exactly as before. */
export const DEFAULT_CHAT_SETTINGS: OrgChatSettings = {
  chatEnabled: true,
  whoCanDm: 'everyone',
  whoCanCreateChannels: 'everyone',
  whoCanCreateGroups: 'everyone',
  whoCanManageGroups: 'creator_and_admins',
  shareHistoryDefault: true,
  attachmentsEnabled: true,
  maxFileSizeMb: 25,
  blockedExtensions: [],
  allowEditOwn: true,
  allowDeleteOwn: true,
  adminCanDeleteAny: true,
  retentionDays: 0,
  broadcastAdminsOnly: false,
};

/**
 * The org admin/owner's control over chat for EMPLOYEES. Reads/writes the single
 * `org_chat_settings` row per org and enforces the gates. Every gate is a no-op
 * for owners/admins (they run the org and are never restricted) and throws
 * `ForbiddenException` for a member the policy blocks.
 */
@Injectable()
export class ChatSettingsService {
  constructor(
    @InjectRepository(OrgChatSettingEntity)
    private readonly repo: Repository<OrgChatSettingEntity>,
    @InjectRepository(OrgMembershipEntity)
    private readonly memberships: Repository<OrgMembershipEntity>,
  ) {}

  /** True for an org role that manages the org (never gated). */
  isAdmin(orgRole: string | null | undefined): boolean {
    return orgRole === 'owner' || orgRole === 'admin';
  }

  /** The org's effective settings (stored values merged over the defaults). */
  async load(orgId: string): Promise<OrgChatSettings> {
    const row = orgId
      ? await this.repo.findOne({ where: { organizationId: orgId } })
      : null;
    return { ...DEFAULT_CHAT_SETTINGS, ...(row?.settings ?? {}) };
  }

  /** Upsert a partial patch (validated + clamped). Returns the new effective settings. */
  async update(orgId: string, patch: Partial<OrgChatSettings>): Promise<OrgChatSettings> {
    const current = await this.load(orgId);
    const next = this.sanitize({ ...current, ...patch });
    let row = await this.repo.findOne({ where: { organizationId: orgId } });
    if (!row) row = this.repo.create({ organizationId: orgId, settings: {} });
    row.settings = next;
    await this.repo.save(row);
    return next;
  }

  /** Coerce/clamp incoming values so a bad payload can't corrupt the policy. */
  private sanitize(s: OrgChatSettings): OrgChatSettings {
    const oneOf = <T extends string>(v: unknown, allowed: T[], fallback: T): T =>
      allowed.includes(v as T) ? (v as T) : fallback;
    return {
      chatEnabled: !!s.chatEnabled,
      whoCanDm: oneOf(s.whoCanDm, ['everyone', 'same_department', 'admins'], 'everyone'),
      whoCanCreateChannels: oneOf(s.whoCanCreateChannels, ['everyone', 'admins'], 'everyone'),
      whoCanCreateGroups: oneOf(s.whoCanCreateGroups, ['everyone', 'admins'], 'everyone'),
      whoCanManageGroups: oneOf(
        s.whoCanManageGroups,
        ['creator_and_admins', 'any_member', 'admins'],
        'creator_and_admins',
      ),
      shareHistoryDefault: s.shareHistoryDefault !== false,
      attachmentsEnabled: !!s.attachmentsEnabled,
      maxFileSizeMb: Math.min(Math.max(Math.round(Number(s.maxFileSizeMb) || 0), 1), 25),
      blockedExtensions: Array.isArray(s.blockedExtensions)
        ? [...new Set(s.blockedExtensions.map((e) => String(e).trim().toLowerCase().replace(/^\./, '')).filter(Boolean))]
        : [],
      allowEditOwn: !!s.allowEditOwn,
      allowDeleteOwn: !!s.allowDeleteOwn,
      adminCanDeleteAny: !!s.adminCanDeleteAny,
      retentionDays: Math.min(Math.max(Math.round(Number(s.retentionDays) || 0), 0), 3650),
      broadcastAdminsOnly: !!s.broadcastAdminsOnly,
    };
  }

  // ── gates (throw for a blocked member; no-op for admins/owners) ────────────

  /** Chat must be enabled for the org (members only). */
  async assertChatEnabled(orgId: string, orgRole?: string | null): Promise<void> {
    if (this.isAdmin(orgRole)) return;
    const s = await this.load(orgId);
    if (!s.chatEnabled) {
      throw new ForbiddenException('Chat is disabled for your organization.');
    }
  }

  /** May the caller start a DM with `targetUserId`? */
  async assertCanDirectMessage(
    orgId: string,
    orgRole: string | null | undefined,
    meId: string,
    targetUserId: string,
  ): Promise<void> {
    if (this.isAdmin(orgRole)) return;
    const s = await this.load(orgId);
    if (!s.chatEnabled) throw new ForbiddenException('Chat is disabled for your organization.');
    if (s.whoCanDm === 'everyone') return;
    if (s.whoCanDm === 'admins') {
      // Members may only DM an admin/owner.
      const target = await this.memberships.findOne({
        where: { organizationId: orgId, userId: targetUserId },
      });
      if (target && (target.role === 'owner' || target.role === 'admin')) return;
      throw new ForbiddenException('You can only message an admin in this organization.');
    }
    // same_department: both must share a department.
    const [me, target] = await Promise.all([
      this.memberships.findOne({ where: { organizationId: orgId, userId: meId } }),
      this.memberships.findOne({ where: { organizationId: orgId, userId: targetUserId } }),
    ]);
    const mine = me?.departmentId ?? null;
    const theirs = target?.departmentId ?? null;
    if (mine && theirs && mine === theirs) return;
    throw new ForbiddenException('You can only message people in your department.');
  }

  /** May the caller create a channel / group? */
  async assertCanCreate(
    orgId: string,
    orgRole: string | null | undefined,
    kind: 'channel' | 'group',
  ): Promise<void> {
    if (this.isAdmin(orgRole)) return;
    const s = await this.load(orgId);
    if (!s.chatEnabled) throw new ForbiddenException('Chat is disabled for your organization.');
    const rule = kind === 'channel' ? s.whoCanCreateChannels : s.whoCanCreateGroups;
    if (rule === 'admins') {
      throw new ForbiddenException(`Only admins can create ${kind === 'channel' ? 'channels' : 'groups'}.`);
    }
  }

  /**
   * Whether the caller may manage a group/channel — add/remove members, rename,
   * change the picture. Org admins/owners always may; otherwise it follows the
   * org's `whoCanManageGroups` policy. `isCreator` = the caller created the
   * conversation; `participantRole` = their role within it (undefined if not a
   * member).
   */
  canManageGroup(
    settings: OrgChatSettings,
    orgRole: string | null | undefined,
    isCreator: boolean,
    participantRole: string | undefined,
  ): boolean {
    if (this.isAdmin(orgRole)) return true;
    if (participantRole === undefined) return false; // must be a member
    switch (settings.whoCanManageGroups) {
      case 'any_member':
        return true;
      case 'admins':
        return false; // only org admins (handled above)
      case 'creator_and_admins':
      default:
        return isCreator || participantRole === 'owner' || participantRole === 'admin';
    }
  }

  /** May the caller send an @everyone / @here broadcast? */
  async assertCanBroadcast(orgId: string, orgRole?: string | null): Promise<void> {
    if (this.isAdmin(orgRole)) return;
    const s = await this.load(orgId);
    if (s.broadcastAdminsOnly) {
      throw new ForbiddenException('Only admins can notify everyone (@here / @everyone).');
    }
  }

  /** May the caller edit their own message? */
  async assertCanEditOwn(orgId: string, orgRole?: string | null): Promise<void> {
    if (this.isAdmin(orgRole)) return;
    const s = await this.load(orgId);
    if (!s.allowEditOwn) throw new ForbiddenException('Editing messages is disabled by your organization.');
  }

  /** Validate an upload against attachment policy (throws on violation). */
  async assertAttachmentAllowed(
    orgId: string,
    orgRole: string | null | undefined,
    fileName: string,
    sizeBytes: number,
  ): Promise<void> {
    if (this.isAdmin(orgRole)) return;
    const s = await this.load(orgId);
    if (!s.attachmentsEnabled) {
      throw new ForbiddenException('File attachments are disabled by your organization.');
    }
    if (sizeBytes > s.maxFileSizeMb * 1024 * 1024) {
      throw new ForbiddenException(`Files must be ${s.maxFileSizeMb} MB or smaller.`);
    }
    const ext = (fileName.split('.').pop() || '').toLowerCase();
    if (ext && s.blockedExtensions.includes(ext)) {
      throw new ForbiddenException(`.${ext} files are not allowed by your organization.`);
    }
  }
}
