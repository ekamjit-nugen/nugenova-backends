import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { Readable } from 'stream';
import * as bcrypt from 'bcrypt';

import { DriveFolderEntity, DriveScope } from './entities/drive-folder.entity';
import { DriveFileEntity } from './entities/drive-file.entity';
import { DriveShareEntity } from './entities/drive-share.entity';
import { DriveQuotaEntity } from './entities/drive-quota.entity';
import { DriveGrantEntity, GrantPermission } from './entities/drive-grant.entity';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { DocumentFileEntity } from '../../bootstrap/storage/document-file.entity';
import { ConversationEntity } from '../chat/entities/conversation.entity';
import { MessageEntity } from '../chat/entities/message.entity';
import { StorageService } from '../../bootstrap/storage/storage.service';
import { NotifierService } from '../notification/notifier.service';
import {
  OFFICE_CONVERT_PROVIDER,
  OfficeConvertProvider,
} from './office-convert.provider';

const GB = 1024 * 1024 * 1024;
export const DEFAULT_TEAM_QUOTA_GB = 50; // org / Team-Drive pool
export const DEFAULT_USER_QUOTA_GB = 1; // per-user My Drive
export const DEFAULT_SHARE_TTL_DAYS = 7; // a link with no explicit date expires in 7 days
const ADMIN_ROLES = ['owner', 'admin'];

/**
 * Cloud Drive service — Postgres/TypeORM port of the legacy Mongo storage
 * service. Two drives, discriminated by `scope`:
 *   - 'personal' My Drive  — private to one user; counts against that user's
 *     personal quota (membership override ?? org default).
 *   - 'team' Team Drive     — shared across the org; counts against the org pool.
 *
 * Bytes are delegated to the shared bootstrap `StorageService` (S3 with a
 * bytea fallback) via `storageFileId`; the drive never builds its own byte store
 * and never hands a client a presigned URL — every download streams through the
 * authenticated proxy.
 *
 * ISOLATION: every method takes `organizationId` and every query filters by it;
 * personal-scope queries additionally filter by `ownerId`, so members never see
 * each other's My Drive.
 */
@Injectable()
export class DriveService {
  private readonly log = new Logger(DriveService.name);

  constructor(
    @InjectRepository(DriveFolderEntity)
    private readonly folders: Repository<DriveFolderEntity>,
    @InjectRepository(DriveFileEntity)
    private readonly files: Repository<DriveFileEntity>,
    @InjectRepository(DriveShareEntity)
    private readonly shares: Repository<DriveShareEntity>,
    @InjectRepository(DriveQuotaEntity)
    private readonly quotas: Repository<DriveQuotaEntity>,
    @InjectRepository(DriveGrantEntity)
    private readonly grants: Repository<DriveGrantEntity>,
    @InjectRepository(OrgMembershipEntity)
    private readonly memberships: Repository<OrgMembershipEntity>,
    @InjectRepository(DocumentFileEntity)
    private readonly documentFiles: Repository<DocumentFileEntity>,
    @InjectRepository(ConversationEntity)
    private readonly conversations: Repository<ConversationEntity>,
    @InjectRepository(MessageEntity)
    private readonly chatMessages: Repository<MessageEntity>,
    private readonly storage: StorageService,
    private readonly notifier: NotifierService,
    @Inject(OFFICE_CONVERT_PROVIDER)
    private readonly officeConvert: OfficeConvertProvider,
  ) {}

  // ─── Helpers ─────────────────────────────────────────────────────

  /** Personal scope is filtered by owner; team scope is owner-agnostic. */
  private ownerFor(scope: DriveScope, userId: string): string | null {
    return scope === 'personal' ? userId : null;
  }

  private async sumBytes(where: {
    organizationId: string;
    scope: DriveScope;
    ownerId: string | null;
  }): Promise<{ bytes: number; count: number }> {
    const qb = this.files
      .createQueryBuilder('f')
      .select('COALESCE(SUM(f.size), 0)', 'bytes')
      .addSelect('COUNT(f.id)', 'count')
      .where('f.organizationId = :orgId', { orgId: where.organizationId })
      .andWhere('f.scope = :scope', { scope: where.scope })
      .andWhere('f.isDeleted = false');
    if (where.ownerId === null) {
      qb.andWhere('f.ownerId IS NULL');
    } else {
      qb.andWhere('f.ownerId = :owner', { owner: where.ownerId });
    }
    const row = await qb.getRawOne<{ bytes: string; count: string }>();
    return { bytes: Number(row?.bytes || 0), count: Number(row?.count || 0) };
  }

  // ─── Quota ───────────────────────────────────────────────────────

  private async teamQuotaRow(
    organizationId: string,
  ): Promise<DriveQuotaEntity | null> {
    return this.quotas.findOne({
      where: { organizationId, ownerId: IsNull() },
    });
  }

  /** Org-pool (Team Drive) quota + usage. */
  async getQuota(organizationId: string): Promise<{
    quotaGb: number;
    quotaBytes: number;
    usedBytes: number;
    usedPercent: number;
    fileCount: number;
    breakdown: { storage: number; media: number };
  }> {
    const row = await this.teamQuotaRow(organizationId);
    const quotaBytes = row?.limitBytes
      ? Number(row.limitBytes)
      : DEFAULT_TEAM_QUOTA_GB * GB;
    const team = await this.sumBytes({
      organizationId,
      scope: 'team',
      ownerId: null,
    });
    return {
      quotaGb: Math.round(quotaBytes / GB),
      quotaBytes,
      usedBytes: team.bytes,
      usedPercent: quotaBytes ? Math.min(100, (team.bytes / quotaBytes) * 100) : 0,
      fileCount: team.count,
      // `media` is reserved for the shared media byte store; not summed here yet
      // (see PLAYBOOK reconciliation seam). Kept for public-shape parity.
      breakdown: { storage: team.bytes, media: 0 },
    };
  }

  async getUserQuota(
    organizationId: string,
    userId: string,
  ): Promise<{
    quotaGb: number;
    quotaBytes: number;
    usedBytes: number;
    usedPercent: number;
    fileCount: number;
  }> {
    const [membership, teamRow, used] = await Promise.all([
      this.memberships.findOne({ where: { organizationId, userId } }),
      this.teamQuotaRow(organizationId),
      this.sumBytes({ organizationId, scope: 'personal', ownerId: userId }),
    ]);
    const override = (membership?.cloudDrive as any)?.quotaGb;
    let quotaBytes: number;
    if (typeof override === 'number') {
      quotaBytes = override * GB;
    } else if (teamRow?.defaultUserLimitBytes) {
      quotaBytes = Number(teamRow.defaultUserLimitBytes);
    } else {
      quotaBytes = DEFAULT_USER_QUOTA_GB * GB;
    }
    return {
      quotaGb: Math.round(quotaBytes / GB),
      quotaBytes,
      usedBytes: used.bytes,
      usedPercent: quotaBytes ? Math.min(100, (used.bytes / quotaBytes) * 100) : 0,
      fileCount: used.count,
    };
  }

  private async assertScopeQuota(
    organizationId: string,
    scope: DriveScope,
    userId: string,
    additionalBytes: number,
  ): Promise<void> {
    if (additionalBytes <= 0) return;
    const q =
      scope === 'personal'
        ? await this.getUserQuota(organizationId, userId)
        : await this.getQuota(organizationId);
    if (q.usedBytes + additionalBytes > q.quotaBytes) {
      const usedGb = (q.usedBytes / GB).toFixed(2);
      const wantMb = (additionalBytes / 1024 / 1024).toFixed(1);
      throw new ForbiddenException({
        code: 'STORAGE_QUOTA_EXCEEDED',
        message:
          `${scope === 'personal' ? 'My Drive' : 'Team Drive'} quota exceeded — ` +
          `${q.quotaGb} GB total, ${usedGb} GB used, wanted ${wantMb} MB more. ` +
          `Free space or ask your admin to raise the quota.`,
        quotaGb: q.quotaGb,
        usedBytes: q.usedBytes,
        attemptedBytes: additionalBytes,
      });
    }
  }

  /** Everything the drive UI needs in one round-trip. */
  async getDriveOverview(organizationId: string, userId: string) {
    const [personal, team] = await Promise.all([
      this.getUserQuota(organizationId, userId),
      this.getQuota(organizationId),
    ]);
    return {
      personal,
      team: {
        quotaGb: team.quotaGb,
        quotaBytes: team.quotaBytes,
        usedBytes: team.usedBytes,
        usedPercent: team.usedPercent,
        fileCount: team.fileCount,
        fileBytes: team.breakdown.storage,
        systemMediaBytes: team.breakdown.media,
      },
    };
  }

  // ─── Access control (per-user grant) ─────────────────────────────

  async canUseCloudDrive(
    organizationId: string,
    userId: string,
    orgRole: string | null,
    isPlatformAdmin = false,
  ): Promise<boolean> {
    if (isPlatformAdmin) return true;
    if (orgRole && ADMIN_ROLES.includes(orgRole)) return true;
    const m = await this.memberships.findOne({ where: { organizationId, userId } });
    return !!(m?.cloudDrive as any)?.enabled;
  }

  async assertCanUseCloudDrive(
    organizationId: string,
    userId: string,
    orgRole: string | null,
    isPlatformAdmin = false,
  ): Promise<void> {
    const ok = await this.canUseCloudDrive(
      organizationId,
      userId,
      orgRole,
      isPlatformAdmin,
    );
    if (!ok) {
      throw new ForbiddenException({
        code: 'CLOUD_DRIVE_NO_ACCESS',
        message:
          'You do not have access to Cloud Drive. Ask your admin to grant it.',
      });
    }
  }

  async setUserAccess(
    organizationId: string,
    userId: string,
    enabled: boolean,
    grantedBy: string,
  ): Promise<void> {
    const m = await this.memberships.findOne({ where: { organizationId, userId } });
    if (!m) throw new NotFoundException('Membership not found');
    m.cloudDrive = {
      ...(m.cloudDrive || {}),
      enabled,
      grantedAt: new Date().toISOString(),
      grantedBy,
    };
    await this.memberships.save(m);

    // Notify the granted member (never a self-notify — actor is the admin).
    if (enabled) {
      void this.notifier
        .notify({
          userId,
          organizationId,
          actorId: grantedBy,
          type: 'storage_access_granted',
          title: 'Cloud Drive enabled',
          body: 'You now have access to Cloud Drive.',
          data: { actionUrl: '/storage' },
          priority: 'normal',
        })
        .catch(() => undefined);
    }
  }

  async setUserQuota(
    organizationId: string,
    userId: string,
    quotaGb: number | null,
  ): Promise<void> {
    if (quotaGb !== null && (quotaGb < 0 || quotaGb > 10_000)) {
      throw new BadRequestException('quotaGb out of range');
    }
    const m = await this.memberships.findOne({ where: { organizationId, userId } });
    if (!m) throw new NotFoundException('Membership not found');
    m.cloudDrive = { ...(m.cloudDrive || {}), quotaGb };
    await this.memberships.save(m);
  }

  async setOrgStorageSettings(
    organizationId: string,
    settings: { defaultUserQuotaGb?: number; quotaGb?: number },
  ): Promise<void> {
    if (
      settings.defaultUserQuotaGb === undefined &&
      settings.quotaGb === undefined
    ) {
      throw new BadRequestException('Nothing to update');
    }
    let row = await this.teamQuotaRow(organizationId);
    if (!row) {
      row = this.quotas.create({
        organizationId,
        ownerId: null,
        limitBytes: String(DEFAULT_TEAM_QUOTA_GB * GB),
        defaultUserLimitBytes: null,
      });
    }
    if (typeof settings.quotaGb === 'number') {
      row.limitBytes = String(settings.quotaGb * GB);
    }
    if (typeof settings.defaultUserQuotaGb === 'number') {
      row.defaultUserLimitBytes = String(settings.defaultUserQuotaGb * GB);
    }
    await this.quotas.save(row);
  }

  /** Member roster with per-user drive access + usage, for the admin UI. */
  async listAccess(organizationId: string): Promise<{
    defaultUserQuotaGb: number;
    teamQuotaGb: number;
    members: Array<{
      userId: string;
      name: string;
      email: string;
      role: string;
      enabled: boolean;
      quotaGb: number | null;
      usedBytes: number;
    }>;
  }> {
    const [teamRow, memberships, usageRows] = await Promise.all([
      this.teamQuotaRow(organizationId),
      this.memberships.find({ where: { organizationId } }),
      this.files
        .createQueryBuilder('f')
        .select('f.ownerId', 'ownerId')
        .addSelect('COALESCE(SUM(f.size), 0)', 'bytes')
        .where('f.organizationId = :orgId', { orgId: organizationId })
        .andWhere('f.scope = :scope', { scope: 'personal' })
        .andWhere('f.isDeleted = false')
        .groupBy('f.ownerId')
        .getRawMany<{ ownerId: string; bytes: string }>(),
    ]);
    const usageByUser = new Map<string, number>(
      usageRows.map((u) => [String(u.ownerId), Number(u.bytes)]),
    );
    const teamQuotaGb = teamRow?.limitBytes
      ? Math.round(Number(teamRow.limitBytes) / GB)
      : DEFAULT_TEAM_QUOTA_GB;
    const defaultUserQuotaGb = teamRow?.defaultUserLimitBytes
      ? Math.round(Number(teamRow.defaultUserLimitBytes) / GB)
      : DEFAULT_USER_QUOTA_GB;
    const members = memberships
      .filter((m) => !!m.userId)
      .map((m) => {
        const cd = (m.cloudDrive as any) || {};
        return {
          userId: m.userId as string,
          name: m.email || (m.userId as string),
          email: m.email || '',
          role: m.role,
          enabled: ADMIN_ROLES.includes(m.role) || !!cd.enabled,
          quotaGb: typeof cd.quotaGb === 'number' ? cd.quotaGb : null,
          usedBytes: usageByUser.get(String(m.userId)) || 0,
        };
      });
    return { defaultUserQuotaGb, teamQuotaGb, members };
  }

  // ─── Folders ─────────────────────────────────────────────────────

  async createFolder(opts: {
    organizationId: string;
    userId: string;
    userDisplayName?: string;
    name: string;
    scope: DriveScope;
    parentId?: string | null;
    systemManaged?: boolean;
  }): Promise<DriveFolderEntity> {
    const name = (opts.name || '').trim();
    if (!name || name.length > 200) {
      throw new BadRequestException('Invalid folder name');
    }
    if (/[/\\]/.test(name)) {
      throw new BadRequestException('Folder name cannot contain slashes');
    }
    const ownerId = this.ownerFor(opts.scope, opts.userId);

    let path = `/${name}`;
    if (opts.parentId) {
      const parent = await this.getOwnedFolder(
        opts.organizationId,
        opts.parentId,
        opts.scope,
        ownerId,
      );
      path = parent.path === '/' ? `/${name}` : `${parent.path}/${name}`;
    }
    const folder = this.folders.create({
      organizationId: opts.organizationId,
      name,
      scope: opts.scope,
      ownerId,
      parentFolderId: opts.parentId || null,
      path,
      createdBy: opts.userId,
      createdByName: opts.userDisplayName ?? null,
      systemManaged: !!opts.systemManaged,
      isDeleted: false,
    });
    return this.folders.save(folder);
  }

  private async getOwnedFolder(
    organizationId: string,
    folderId: string,
    scope: DriveScope,
    ownerId: string | null,
  ): Promise<DriveFolderEntity> {
    const f = await this.folders.findOne({
      where: {
        id: folderId,
        organizationId,
        scope,
        ownerId: ownerId === null ? IsNull() : ownerId,
        isDeleted: false,
      },
    });
    if (!f) throw new NotFoundException('Folder not found');
    return f;
  }

  async listFolders(
    organizationId: string,
    scope: DriveScope,
    userId: string,
    parentId: string | null,
  ): Promise<DriveFolderEntity[]> {
    const ownerId = this.ownerFor(scope, userId);
    return this.folders.find({
      where: {
        organizationId,
        scope,
        ownerId: ownerId === null ? IsNull() : ownerId,
        parentFolderId: parentId === null ? IsNull() : parentId,
        isDeleted: false,
        systemManaged: false,
      },
      order: { name: 'ASC' },
    });
  }

  async getBreadcrumb(
    organizationId: string,
    scope: DriveScope,
    userId: string,
    folderId: string | null,
  ): Promise<Array<{ _id: string; name: string }>> {
    if (!folderId) return [];
    const ownerId = this.ownerFor(scope, userId);
    const trail: Array<{ _id: string; name: string }> = [];
    let current: string | null = folderId;
    for (let i = 0; i < 64 && current; i++) {
      const f: DriveFolderEntity | null = await this.folders.findOne({
        where: {
          id: current,
          organizationId,
          scope,
          ownerId: ownerId === null ? IsNull() : ownerId,
          isDeleted: false,
        },
      });
      if (!f) break;
      trail.unshift({ _id: f.id, name: f.name });
      current = f.parentFolderId;
    }
    return trail;
  }

  async renameFolder(
    organizationId: string,
    folderId: string,
    scope: DriveScope,
    userId: string,
    name: string,
  ): Promise<DriveFolderEntity> {
    const clean = (name || '').trim();
    if (!clean || clean.length > 200 || /[/\\]/.test(clean)) {
      throw new BadRequestException('Invalid folder name');
    }
    const ownerId = this.ownerFor(scope, userId);
    const folder = await this.getOwnedFolder(
      organizationId,
      folderId,
      scope,
      ownerId,
    );
    folder.name = clean;
    const parentPath = folder.path.slice(0, folder.path.lastIndexOf('/'));
    folder.path = `${parentPath}/${clean}`;
    await this.folders.save(folder);
    await this.recomputeSubtreePaths(folder);
    return folder;
  }

  private async recomputeSubtreePaths(root: DriveFolderEntity): Promise<void> {
    const queue: Array<{ id: string; path: string }> = [
      { id: root.id, path: root.path },
    ];
    while (queue.length) {
      const { id, path } = queue.shift()!;
      const children = await this.folders.find({
        where: {
          organizationId: root.organizationId,
          parentFolderId: id,
          isDeleted: false,
        },
      });
      for (const c of children) {
        c.path = `${path}/${c.name}`;
        await this.folders.save(c);
        queue.push({ id: c.id, path: c.path });
      }
    }
  }

  async moveFolder(
    organizationId: string,
    folderId: string,
    scope: DriveScope,
    userId: string,
    targetParentId: string | null,
  ): Promise<DriveFolderEntity> {
    const ownerId = this.ownerFor(scope, userId);
    const folder = await this.getOwnedFolder(
      organizationId,
      folderId,
      scope,
      ownerId,
    );
    if (targetParentId && targetParentId === folderId) {
      throw new BadRequestException('Cannot move a folder into itself');
    }
    let parentPath = '';
    if (targetParentId) {
      const target = await this.getOwnedFolder(
        organizationId,
        targetParentId,
        scope,
        ownerId,
      );
      const subtree = new Set(
        await this.collectSubtreeFolderIds(organizationId, folderId),
      );
      if (subtree.has(targetParentId)) {
        throw new BadRequestException('Cannot move a folder into its own subtree');
      }
      parentPath = target.path === '/' ? '' : target.path;
    }
    folder.parentFolderId = targetParentId || null;
    folder.path = `${parentPath}/${folder.name}`;
    await this.folders.save(folder);
    await this.recomputeSubtreePaths(folder);
    return folder;
  }

  async deleteFolder(
    organizationId: string,
    folderId: string,
    scope: DriveScope,
    userId: string,
  ): Promise<void> {
    const ownerId = this.ownerFor(scope, userId);
    await this.getOwnedFolder(organizationId, folderId, scope, ownerId);
    const folderIds = await this.collectSubtreeFolderIds(organizationId, folderId);

    await this.folders
      .createQueryBuilder()
      .update()
      .set({ isDeleted: true })
      .whereInIds(folderIds)
      .execute();

    const files = await this.files
      .createQueryBuilder('f')
      .where('f.organizationId = :orgId', { orgId: organizationId })
      .andWhere('f.folderId IN (:...ids)', { ids: folderIds })
      .andWhere('f.isDeleted = false')
      .getMany();

    if (files.length) {
      await this.files
        .createQueryBuilder()
        .update()
        .set({ isDeleted: true })
        .whereInIds(files.map((f) => f.id))
        .execute();
    }

    // Revoke any shares that targeted these folders/files.
    const fileIds = files.map((f) => f.id);
    await this.shares
      .createQueryBuilder()
      .update()
      .set({ revoked: true })
      .where('organization_id = :orgId', { orgId: organizationId })
      .andWhere(
        '((target_type = :folder AND target_id IN (:...folderIds))' +
          (fileIds.length
            ? ' OR (target_type = :file AND target_id IN (:...fileIds)))'
            : ')'),
        {
          folder: 'folder',
          file: 'file',
          folderIds,
          ...(fileIds.length ? { fileIds } : {}),
        },
      )
      .execute();

    // Drop internal grants pointing at any deleted folder/file in the subtree.
    const grantTargets = [...folderIds, ...fileIds];
    if (grantTargets.length) {
      await this.grants
        .createQueryBuilder()
        .delete()
        .where('organization_id = :orgId', { orgId: organizationId })
        .andWhere('target_id IN (:...ids)', { ids: grantTargets })
        .execute();
    }
  }

  private async collectSubtreeFolderIds(
    organizationId: string,
    rootId: string,
  ): Promise<string[]> {
    const ids = [rootId];
    const queue = [rootId];
    while (queue.length) {
      const parentFolderId = queue.shift()!;
      const children = await this.folders.find({
        where: { organizationId, parentFolderId, isDeleted: false },
        select: { id: true },
      });
      for (const c of children) {
        ids.push(c.id);
        queue.push(c.id);
      }
    }
    return ids;
  }

  // ─── Upload / list / files ───────────────────────────────────────

  async uploadFile(opts: {
    organizationId: string;
    userId: string;
    userDisplayName?: string;
    name: string;
    scope: DriveScope;
    folderId?: string | null;
    contentType?: string;
    body: Buffer;
    tags?: string[];
    systemManaged?: boolean;
  }): Promise<DriveFileEntity> {
    if (!opts.body?.length) throw new BadRequestException('Empty file');
    await this.assertScopeQuota(
      opts.organizationId,
      opts.scope,
      opts.userId,
      opts.body.length,
    );
    const ownerId = this.ownerFor(opts.scope, opts.userId);
    const folderId = await this.resolveTargetFolder(
      opts.organizationId,
      opts.folderId,
      opts.scope,
      ownerId,
    );

    // Delegate the bytes to the shared byte store (S3 or bytea).
    const stored = await this.storage.save({
      organizationId: opts.organizationId,
      originalName: opts.name,
      mimeType: opts.contentType || 'application/octet-stream',
      buffer: opts.body,
      uploadedBy: opts.userId,
      category: 'drive',
    });

    const file = this.files.create({
      organizationId: opts.organizationId,
      name: opts.name,
      size: stored.size,
      mimeType: stored.mimeType,
      storageFileId: stored.id,
      scope: opts.scope,
      ownerId,
      folderId,
      uploadedBy: opts.userId,
      uploadedByName: opts.userDisplayName ?? null,
      tags: opts.tags || [],
      systemManaged: !!opts.systemManaged,
      isDeleted: false,
    });
    return this.files.save(file);
  }

  // ─── Bridge from the shared byte store (chat / onboarding / …) ────
  //
  // Files uploaded elsewhere in the app (chat attachments, onboarding docs)
  // live in `document_files` via the shared StorageService and would otherwise
  // never surface in Cloud Drive. The drive is meant to be the single vault for
  // "all the storage files", so we INDEX those existing bytes here: a
  // `drive_files` row pointing at the SAME `storageFileId` (no byte copy).
  //
  // ROUTING (who sees a bridged file):
  //   - chat in a DIRECT (1:1) conversation → each participant's My Drive
  //     (personal scope, one row per participant). A private DM attachment stays
  //     private to the two people, never the whole org.
  //   - chat in a group/channel             → Team Drive (org-visible).
  //   - onboarding / other categories       → Team Drive under a category folder.
  // All land in a browsable "Shared in Chat" / "Onboarding" / "Org Files" folder.

  private readonly SYSTEM_ACTOR = 'system';
  private readonly CHAT_FOLDER = 'Shared in Chat';

  /** Stable landing-folder name for a NON-chat bridged file's category. */
  private bridgeFolderName(category: string | null | undefined): string {
    switch (category) {
      case 'onboarding':
        return 'Onboarding';
      default:
        return 'Org Files';
    }
  }

  /**
   * Find (or create) a browsable bridge landing folder for a given scope/owner.
   * Created `systemManaged: false` so bridged files actually show up in browse.
   * Personal-scope folders are per-owner (each participant gets their own).
   */
  private async ensureBridgeFolder(
    organizationId: string,
    scope: DriveScope,
    ownerId: string | null,
    name: string,
  ): Promise<DriveFolderEntity> {
    const existing = await this.folders.findOne({
      where: {
        organizationId,
        scope,
        ownerId: ownerId === null ? IsNull() : ownerId,
        parentFolderId: IsNull(),
        name,
        isDeleted: false,
      },
    });
    if (existing) return existing;
    return this.folders.save(
      this.folders.create({
        organizationId,
        name,
        scope,
        ownerId,
        parentFolderId: null,
        path: `/${name}`,
        createdBy: this.SYSTEM_ACTOR,
        createdByName: 'System',
        systemManaged: false,
        isDeleted: false,
      }),
    );
  }

  /**
   * Idempotently index one stored doc into a (scope, ownerId) drive location.
   * Keyed on (storageFileId, scope, ownerId), so repeat backfills / a live
   * listener racing never create duplicates.
   */
  private async indexBridge(
    doc: DocumentFileEntity,
    scope: DriveScope,
    ownerId: string | null,
    folderName: string,
    tag: string | null,
  ): Promise<DriveFileEntity> {
    const existing = await this.files.findOne({
      where: {
        storageFileId: doc.id,
        scope,
        ownerId: ownerId === null ? IsNull() : ownerId,
        isDeleted: false,
      },
    });
    if (existing) return existing;
    const folder = await this.ensureBridgeFolder(
      doc.organizationId,
      scope,
      ownerId,
      folderName,
    );
    return this.files.save(
      this.files.create({
        organizationId: doc.organizationId,
        name: doc.originalName,
        size: doc.size,
        mimeType: doc.mimeType,
        storageFileId: doc.id,
        scope,
        ownerId,
        folderId: folder.id,
        uploadedBy: doc.uploadedBy || this.SYSTEM_ACTOR,
        uploadedByName: null,
        tags: tag ? [tag] : [],
        systemManaged: false,
        isDeleted: false,
      }),
    );
  }

  /** Soft-delete every bridged index row for a storageFileId not in `keep`. */
  private async pruneBridgeRows(
    storageFileId: string,
    keep: DriveFileEntity[],
  ): Promise<void> {
    const keepIds = new Set(keep.map((r) => r.id));
    const rows = await this.files.find({
      where: { storageFileId, isDeleted: false },
    });
    const stale = rows.filter((r) => !keepIds.has(r.id));
    if (stale.length) {
      await this.files
        .createQueryBuilder()
        .update()
        .set({ isDeleted: true })
        .whereInIds(stale.map((r) => r.id))
        .execute();
    }
  }

  /**
   * Route one chat attachment into the drive based on its conversation:
   * DM → both participants' My Drive; group/channel → Team Drive. Reconciles as
   * it goes — indexing a file to its correct location prunes any row left at the
   * wrong scope (e.g. a DM file previously mirrored to Team Drive).
   */
  private async applyChatBridge(
    conv: ConversationEntity,
    doc: DocumentFileEntity,
  ): Promise<DriveFileEntity[]> {
    const kept: DriveFileEntity[] = [];
    if (conv.type === 'direct') {
      const participants = (conv.participantIds || []).filter(Boolean);
      for (const uid of participants) {
        kept.push(
          await this.indexBridge(doc, 'personal', uid, this.CHAT_FOLDER, 'chat'),
        );
      }
    } else {
      kept.push(
        await this.indexBridge(doc, 'team', null, this.CHAT_FOLDER, 'chat'),
      );
    }
    await this.pruneBridgeRows(doc.id, kept);
    return kept;
  }

  /** File ids referenced by a chat message (flat column + attachments[] jsonb). */
  private messageFileIds(msg: MessageEntity): string[] {
    const ids = new Set<string>();
    if (msg.fileId) ids.add(msg.fileId);
    const attachments = Array.isArray((msg as any).attachments)
      ? ((msg as any).attachments as Array<{ fileId?: string | null }>)
      : [];
    for (const a of attachments) if (a?.fileId) ids.add(a.fileId);
    return [...ids];
  }

  /**
   * Live entry point (called by DriveChatBridge on CHAT_MESSAGE_NEW): index a
   * just-sent message's attachments into the right drive(s). Looks up the
   * conversation itself so the caller stays thin. No-op when the message has no
   * attachment or the conversation isn't found in this org.
   */
  async bridgeChatMessage(params: {
    organizationId: string;
    conversationId: string;
    fileIds: string[];
  }): Promise<void> {
    const fileIds = (params.fileIds || []).filter(Boolean);
    if (!fileIds.length) return;
    const conv = await this.conversations.findOne({
      where: { id: params.conversationId, organizationId: params.organizationId },
    });
    if (!conv) return;
    for (const fileId of fileIds) {
      const doc = await this.documentFiles.findOne({
        where: { id: fileId, organizationId: params.organizationId, isDeleted: false },
      });
      if (doc && doc.category !== 'drive') await this.applyChatBridge(conv, doc);
    }
  }

  /**
   * Index one NON-chat stored doc (onboarding, …) into Team Drive. Chat files go
   * through the conversation-aware {@link bridgeChatMessage} path instead.
   * Idempotent; returns null for missing/cross-org/drive-native/chat docs.
   */
  async bridgeDocumentFile(
    documentFileId: string,
    opts: { organizationId?: string } = {},
  ): Promise<DriveFileEntity | null> {
    const doc = await this.documentFiles.findOne({
      where: { id: documentFileId, isDeleted: false },
    });
    if (!doc) return null;
    if (opts.organizationId && doc.organizationId !== opts.organizationId) return null;
    if (doc.category === 'drive' || doc.category === 'chat') return null;
    return this.indexBridge(
      doc,
      'team',
      null,
      this.bridgeFolderName(doc.category),
      doc.category ?? null,
    );
  }

  /**
   * One-shot backfill for an org, safe to re-run (idempotent + self-healing):
   *   - chat: rebuild from `chat_messages`, routing DM→My Drive / group→Team,
   *     and prune any "Shared in Chat" index row no longer backed by a sent
   *     message at the right scope.
   *   - other categories (onboarding, …): index each `document_files` row.
   */
  async backfillFromStorage(
    organizationId: string,
  ): Promise<{ scanned: number; linked: number; pruned: number }> {
    let linked = 0;
    let scanned = 0;

    // ── chat: message-driven (only files in a LIVE sent message get bridged;
    // a deleted message's attachment is pruned below, not re-indexed) ──
    const messages = await this.chatMessages.find({
      where: { organizationId, isDeleted: false },
    });
    const convCache = new Map<string, ConversationEntity | null>();
    const desiredByFile = new Map<string, DriveFileEntity[]>();
    for (const msg of messages) {
      const fileIds = this.messageFileIds(msg);
      if (!fileIds.length) continue;
      let conv = convCache.get(msg.conversationId);
      if (conv === undefined) {
        conv = await this.conversations.findOne({
          where: { id: msg.conversationId, organizationId },
        });
        convCache.set(msg.conversationId, conv);
      }
      if (!conv) continue;
      for (const fileId of fileIds) {
        const doc = await this.documentFiles.findOne({
          where: { id: fileId, organizationId, isDeleted: false },
        });
        if (!doc || doc.category === 'drive') continue;
        scanned++;
        const kept = await this.applyChatBridge(conv, doc);
        linked += kept.length;
        desiredByFile.set(doc.id, kept);
      }
    }

    // Prune "Shared in Chat" rows whose file is no longer backed by a message
    // at any scope (e.g. the old team mirror of an unsent draft, a deleted msg).
    const chatFolders = await this.folders.find({
      where: { organizationId, name: this.CHAT_FOLDER, isDeleted: false },
    });
    const chatFolderIds = new Set(chatFolders.map((f) => f.id));
    let pruned = 0;
    if (chatFolderIds.size) {
      const chatRows = await this.files.find({
        where: { organizationId, isDeleted: false },
      });
      const stale = chatRows.filter(
        (r) =>
          r.folderId &&
          chatFolderIds.has(r.folderId) &&
          !(desiredByFile.get(r.storageFileId) || []).some((k) => k.id === r.id),
      );
      if (stale.length) {
        await this.files
          .createQueryBuilder()
          .update()
          .set({ isDeleted: true })
          .whereInIds(stale.map((r) => r.id))
          .execute();
        pruned = stale.length;
      }
    }

    // ── non-chat categories (onboarding, …): document-driven ──
    const otherDocs = await this.documentFiles.find({
      where: { organizationId, isDeleted: false },
    });
    for (const doc of otherDocs) {
      if (doc.category === 'chat' || doc.category === 'drive') continue;
      scanned++;
      const row = await this.bridgeDocumentFile(doc.id, { organizationId });
      if (row) linked++;
    }

    this.log.log(
      `backfillFromStorage(${organizationId}): scanned=${scanned} linked=${linked} pruned=${pruned}`,
    );
    return { scanned, linked, pruned };
  }

  private async resolveTargetFolder(
    organizationId: string,
    folderId: string | null | undefined,
    scope: DriveScope,
    ownerId: string | null,
  ): Promise<string | null> {
    if (!folderId) return null;
    await this.getOwnedFolder(organizationId, folderId, scope, ownerId);
    return folderId;
  }

  async listFiles(
    organizationId: string,
    scope: DriveScope,
    userId: string,
    folderId: string | null,
    page = 1,
    limit = 50,
  ): Promise<{ data: DriveFileEntity[]; total: number }> {
    const ownerId = this.ownerFor(scope, userId);
    const take = Math.min(Math.max(1, limit), 200);
    const [data, total] = await this.files.findAndCount({
      where: {
        organizationId,
        scope,
        ownerId: ownerId === null ? IsNull() : ownerId,
        folderId: folderId === null ? IsNull() : folderId,
        isDeleted: false,
        systemManaged: false,
      },
      order: { updatedAt: 'DESC' },
      skip: (Math.max(1, page) - 1) * take,
      take,
    });
    return { data, total };
  }

  private async getOwnedFile(
    organizationId: string,
    fileId: string,
    scope: DriveScope,
    ownerId: string | null,
  ): Promise<DriveFileEntity> {
    const f = await this.files.findOne({
      where: {
        id: fileId,
        organizationId,
        scope,
        ownerId: ownerId === null ? IsNull() : ownerId,
        isDeleted: false,
      },
    });
    if (!f) throw new NotFoundException('File not found');
    return f;
  }

  async renameFile(
    organizationId: string,
    fileId: string,
    scope: DriveScope,
    userId: string,
    name: string,
  ): Promise<DriveFileEntity> {
    const clean = (name || '').trim();
    if (!clean || clean.length > 255) {
      throw new BadRequestException('Invalid file name');
    }
    // Owner OR an org member with an 'edit' grant may rename.
    const file = await this.resolveFileForWrite(organizationId, fileId, userId);
    file.name = clean;
    return this.files.save(file);
  }

  async moveFile(
    organizationId: string,
    fileId: string,
    scope: DriveScope,
    userId: string,
    targetFolderId: string | null,
  ): Promise<DriveFileEntity> {
    const ownerId = this.ownerFor(scope, userId);
    const file = await this.getOwnedFile(organizationId, fileId, scope, ownerId);
    file.folderId = await this.resolveTargetFolder(
      organizationId,
      targetFolderId,
      scope,
      ownerId,
    );
    return this.files.save(file);
  }

  /** Stream a file's bytes through the API (authenticated in-app viewer). */
  async getFileStream(
    organizationId: string,
    fileId: string,
  ): Promise<{
    stream: Readable;
    mimeType: string;
    filename: string;
    size: number | null;
  }> {
    const f = await this.files.findOne({
      where: { id: fileId, organizationId, isDeleted: false },
    });
    if (!f) throw new NotFoundException('File not found');
    const meta = await this.storage.getMeta(f.storageFileId);
    const opened = await this.storage.openStream(meta);
    // Prefer the drive's own display name over the stored original name.
    return { ...opened, filename: f.name || opened.filename };
  }

  /**
   * Serve a file as PDF for in-app preview. PDFs stream straight through; office
   * documents are handled by the pluggable OfficeConvertProvider (no-op default,
   * so unsupported types 400). No LibreOffice dependency in this build.
   */
  async getPreviewPdf(
    organizationId: string,
    fileId: string,
  ): Promise<{ stream: Readable; name: string; size: number | null }> {
    const f = await this.files.findOne({
      where: { id: fileId, organizationId, isDeleted: false },
    });
    if (!f) throw new NotFoundException('File not found');
    const meta = await this.storage.getMeta(f.storageFileId);

    if ((f.mimeType || '').includes('pdf') || /\.pdf$/i.test(f.name)) {
      const opened = await this.storage.openStream(meta);
      return { stream: opened.stream, name: f.name, size: opened.size };
    }

    if (!this.officeConvert.isConvertible(f.name)) {
      throw new BadRequestException(
        'This file type cannot be previewed as PDF in this build',
      );
    }
    const bytes = await this.storage.getBytes(meta);
    const pdf = await this.officeConvert.convertToPdf(bytes, f.name);
    const pdfName = f.name.replace(/\.[^.]+$/, '') + '.pdf';
    return { stream: Readable.from(pdf), name: pdfName, size: pdf.length };
  }

  async deleteFile(
    organizationId: string,
    fileId: string,
    scope: DriveScope,
    userId: string,
  ): Promise<void> {
    const ownerId = this.ownerFor(scope, userId);
    const f = await this.getOwnedFile(organizationId, fileId, scope, ownerId);
    f.isDeleted = true;
    await this.files.save(f);
    // Revoke any file share pointing at it. Note: the underlying document_files
    // bytes are NOT hard-deleted here (StorageService exposes no delete yet — a
    // byte-GC seam noted in PLAYBOOK).
    await this.shares.update(
      { organizationId, targetType: 'file', targetId: fileId },
      { revoked: true },
    );
    // Also drop any internal grants (they'd otherwise dangle in "Shared with me").
    await this.grants.delete({ organizationId, targetType: 'file', targetId: fileId });
  }

  // ─── Internal grants (share with org members) ────────────────────
  //
  // Give another org member view/download/edit access to a file/folder WITHOUT a
  // public link. The grant is the discoverability record ("Shared with me") and
  // authorizes a non-owner on the authenticated endpoints. `edit` additionally
  // permits rename + content replace (delete/move stay owner-only).

  /** The owner (or team) of a target may manage its grants. */
  private async assertCanManageShares(
    organizationId: string,
    targetType: 'file' | 'folder',
    targetId: string,
    userId: string,
  ): Promise<DriveScope> {
    if (targetType === 'file') {
      const f = await this.files.findOne({
        where: { id: targetId, organizationId, isDeleted: false },
      });
      if (!f) throw new NotFoundException('File not found');
      if (f.scope === 'personal' && f.ownerId !== userId) {
        throw new ForbiddenException('Only the owner can share this file');
      }
      return f.scope;
    }
    const fo = await this.folders.findOne({
      where: { id: targetId, organizationId, isDeleted: false },
    });
    if (!fo) throw new NotFoundException('Folder not found');
    if (fo.scope === 'personal' && fo.ownerId !== userId) {
      throw new ForbiddenException('Only the owner can share this folder');
    }
    return fo.scope;
  }

  async grantAccess(opts: {
    organizationId: string;
    actorId: string;
    actorName?: string | null;
    targetType: 'file' | 'folder';
    targetId: string;
    granteeUserIds: string[];
    permission: GrantPermission;
  }): Promise<{ granted: number }> {
    const scope = await this.assertCanManageShares(
      opts.organizationId,
      opts.targetType,
      opts.targetId,
      opts.actorId,
    );
    const grantees = [...new Set(opts.granteeUserIds)].filter(
      (u) => u && u !== opts.actorId,
    );
    let granted = 0;
    for (const granteeUserId of grantees) {
      const member = await this.memberships.findOne({
        where: { organizationId: opts.organizationId, userId: granteeUserId },
      });
      if (!member) continue; // never grant to a non-member
      // Sharing an item with someone means they must be able to open it — so
      // ensure the grantee has Cloud Drive access (they'd otherwise be blocked by
      // CloudDriveAccessGuard and never see the "Shared with me" item).
      const cd = (member.cloudDrive as any) || {};
      if (!cd.enabled) {
        member.cloudDrive = {
          ...cd,
          enabled: true,
          grantedAt: new Date().toISOString(),
          grantedBy: opts.actorId,
          viaShare: true,
        };
        await this.memberships.save(member);
      }
      const existing = await this.grants.findOne({
        where: {
          organizationId: opts.organizationId,
          targetType: opts.targetType,
          targetId: opts.targetId,
          granteeUserId,
        },
      });
      if (existing) {
        existing.permission = opts.permission;
        existing.grantedBy = opts.actorId;
        existing.grantedByName = opts.actorName ?? existing.grantedByName ?? null;
        await this.grants.save(existing);
      } else {
        await this.grants.save(
          this.grants.create({
            organizationId: opts.organizationId,
            targetType: opts.targetType,
            targetId: opts.targetId,
            scope,
            granteeUserId,
            permission: opts.permission,
            grantedBy: opts.actorId,
            grantedByName: opts.actorName ?? null,
          }),
        );
      }
      granted++;
      // Best-effort in-app notification to the grantee.
      const name =
        opts.targetType === 'file'
          ? (await this.files.findOne({ where: { id: opts.targetId } }))?.name
          : (await this.folders.findOne({ where: { id: opts.targetId } }))?.name;
      void this.notifier
        .notify({
          userId: granteeUserId,
          organizationId: opts.organizationId,
          actorId: opts.actorId,
          type: 'drive_shared',
          title: 'A file was shared with you',
          body: `${opts.actorName || 'A teammate'} shared "${name ?? 'an item'}" with you`,
          data: { actionUrl: '/storage' },
          priority: 'normal',
        })
        .catch(() => undefined);
    }
    return { granted };
  }

  /** Who currently has an internal grant on a target (for the manage-access UI). */
  async listGrants(
    organizationId: string,
    targetType: 'file' | 'folder',
    targetId: string,
  ): Promise<
    Array<{ id: string; granteeUserId: string; permission: GrantPermission }>
  > {
    const rows = await this.grants.find({
      where: { organizationId, targetType, targetId },
      order: { createdAt: 'ASC' },
    });
    return rows.map((g) => ({
      id: g.id,
      granteeUserId: g.granteeUserId,
      permission: g.permission,
    }));
  }

  async revokeGrant(
    organizationId: string,
    grantId: string,
    actorId: string,
  ): Promise<void> {
    const g = await this.grants.findOne({ where: { id: grantId, organizationId } });
    if (!g) throw new NotFoundException('Grant not found');
    // The grantor, the owner of the target, or the grantee themselves may revoke.
    let canManage = g.grantedBy === actorId || g.granteeUserId === actorId;
    if (!canManage) {
      try {
        await this.assertCanManageShares(organizationId, g.targetType, g.targetId, actorId);
        canManage = true;
      } catch {
        /* not the owner */
      }
    }
    if (!canManage) throw new ForbiddenException('You cannot revoke this share');
    await this.grants.delete({ id: grantId, organizationId });
  }

  /** Files + folders shared WITH the current user (the "Shared with me" surface). */
  async listSharedWithMe(
    organizationId: string,
    userId: string,
  ): Promise<{
    files: Array<
      DriveFileEntity & { permission: GrantPermission; sharedByName: string | null; grantId: string }
    >;
    folders: Array<{
      id: string;
      name: string;
      permission: GrantPermission;
      sharedByName: string | null;
      grantId: string;
    }>;
  }> {
    const rows = await this.grants.find({
      where: { organizationId, granteeUserId: userId },
      order: { createdAt: 'DESC' },
    });
    const files: any[] = [];
    const folders: any[] = [];
    for (const g of rows) {
      if (g.targetType === 'file') {
        const f = await this.files.findOne({
          where: { id: g.targetId, organizationId, isDeleted: false },
        });
        if (f) files.push({ ...f, permission: g.permission, sharedByName: g.grantedByName, grantId: g.id });
      } else {
        const fo = await this.folders.findOne({
          where: { id: g.targetId, organizationId, isDeleted: false },
        });
        if (fo)
          folders.push({
            id: fo.id,
            name: fo.name,
            permission: g.permission,
            sharedByName: g.grantedByName,
            grantId: g.id,
          });
      }
    }
    return { files, folders };
  }

  /**
   * Resolve a file the user may WRITE to (rename / replace content): the owner of
   * a personal file, anyone for a team file, or a member holding an `edit` grant.
   * Throws 403 otherwise.
   */
  private async resolveFileForWrite(
    organizationId: string,
    fileId: string,
    userId: string,
  ): Promise<DriveFileEntity> {
    const file = await this.files.findOne({
      where: { id: fileId, organizationId, isDeleted: false },
    });
    if (!file) throw new NotFoundException('File not found');
    const isOwner = file.scope === 'team' ? true : file.ownerId === userId;
    if (isOwner) return file;
    const grant = await this.grants.findOne({
      where: { organizationId, targetType: 'file', targetId: fileId, granteeUserId: userId },
    });
    if (grant && grant.permission === 'edit') return file;
    throw new ForbiddenException('You do not have edit access to this file');
  }

  /**
   * Replace a file's CONTENT with new bytes (an editor uploading a new version).
   * The drive row (name, folder, scope, owner) is unchanged; only the bytes +
   * size + mime are swapped. Requires ownership or an `edit` grant.
   */
  async replaceFileContent(opts: {
    organizationId: string;
    fileId: string;
    userId: string;
    contentType?: string;
    body: Buffer;
  }): Promise<DriveFileEntity> {
    if (!opts.body?.length) throw new BadRequestException('Empty file');
    const file = await this.resolveFileForWrite(
      opts.organizationId,
      opts.fileId,
      opts.userId,
    );
    // Quota is checked against the owner's scope for the delta.
    const delta = opts.body.length - file.size;
    if (delta > 0) {
      await this.assertScopeQuota(
        opts.organizationId,
        file.scope,
        file.ownerId ?? opts.userId,
        delta,
      );
    }
    const stored = await this.storage.save({
      organizationId: opts.organizationId,
      originalName: file.name,
      mimeType: opts.contentType || file.mimeType,
      buffer: opts.body,
      uploadedBy: opts.userId,
      category: 'drive',
    });
    file.storageFileId = stored.id;
    file.size = stored.size;
    file.mimeType = stored.mimeType;
    return this.files.save(file);
  }

  // ─── External shares (management) ────────────────────────────────

  async createShare(opts: {
    organizationId: string;
    userId: string;
    userDisplayName?: string;
    targetType: 'file' | 'folder';
    targetId: string;
    scope: DriveScope;
    permission?: 'view' | 'download';
    password?: string | null;
    expiresAt?: string | null;
  }): Promise<{ token: string; share: DriveShareEntity }> {
    const ownerId = this.ownerFor(opts.scope, opts.userId);
    if (opts.targetType === 'file') {
      await this.getOwnedFile(
        opts.organizationId,
        opts.targetId,
        opts.scope,
        ownerId,
      );
    } else {
      await this.getOwnedFolder(
        opts.organizationId,
        opts.targetId,
        opts.scope,
        ownerId,
      );
    }

    // Default the link to expire in 7 days when the caller doesn't pin a date,
    // so a forgotten link doesn't live forever. An explicit null still means
    // "never expires" (the client sends the sentinel to opt out).
    let expiresAt: Date | null = new Date(Date.now() + DEFAULT_SHARE_TTL_DAYS * 86_400_000);
    if (opts.expiresAt === null) {
      expiresAt = null; // caller explicitly chose "never"
    } else if (opts.expiresAt) {
      const d = new Date(opts.expiresAt);
      if (isNaN(d.getTime())) throw new BadRequestException('Invalid expiresAt');
      expiresAt = d;
    }
    const passwordHash = opts.password
      ? await bcrypt.hash(opts.password, 10)
      : null;

    const token = randomBytes(24).toString('base64url');
    const share = await this.shares.save(
      this.shares.create({
        organizationId: opts.organizationId,
        token,
        targetType: opts.targetType,
        targetId: opts.targetId,
        scope: opts.scope,
        permission: opts.permission === 'view' ? 'view' : 'download',
        passwordHash,
        expiresAt,
        revoked: false,
        accessCount: 0,
        createdBy: opts.userId,
        createdByName: opts.userDisplayName ?? null,
      }),
    );
    return { token, share };
  }

  async listShares(organizationId: string, userId: string): Promise<any[]> {
    const shares = await this.shares.find({
      where: { organizationId, createdBy: userId },
      order: { createdAt: 'DESC' },
    });
    return Promise.all(
      shares.map(async (s) => {
        let targetName = '(deleted)';
        if (s.targetType === 'file') {
          const f = await this.files.findOne({
            where: { id: s.targetId },
            select: { name: true },
          });
          targetName = f?.name ?? targetName;
        } else {
          const fo = await this.folders.findOne({
            where: { id: s.targetId },
            select: { name: true },
          });
          targetName = fo?.name ?? targetName;
        }
        return {
          _id: s.id,
          token: s.token,
          targetType: s.targetType,
          targetName,
          permission: s.permission,
          hasPassword: !!s.passwordHash,
          expiresAt: s.expiresAt,
          revoked: s.revoked,
          accessCount: s.accessCount,
          lastAccessedAt: s.lastAccessedAt,
          createdAt: s.createdAt,
        };
      }),
    );
  }

  async revokeShare(
    organizationId: string,
    shareId: string,
    userId: string,
  ): Promise<void> {
    const res = await this.shares.update(
      { id: shareId, organizationId, createdBy: userId },
      { revoked: true },
    );
    if (!res.affected) throw new NotFoundException('Share not found');
  }

  // ─── External shares (public resolution) ─────────────────────────

  private async resolveShare(token: string): Promise<DriveShareEntity> {
    const share = await this.shares.findOne({ where: { token } });
    if (!share || share.revoked) throw new NotFoundException('Share not found');
    if (share.expiresAt && share.expiresAt.getTime() < Date.now()) {
      throw new ForbiddenException({
        code: 'SHARE_EXPIRED',
        message: 'This link has expired.',
      });
    }
    return share;
  }

  async getShareInfo(token: string): Promise<{
    targetType: 'file' | 'folder';
    name: string;
    permission: 'view' | 'download';
    requiresPassword: boolean;
  }> {
    const share = await this.resolveShare(token);
    let name = 'Shared item';
    if (share.targetType === 'file') {
      const f = await this.files.findOne({
        where: { id: share.targetId },
        select: { name: true },
      });
      name = f?.name ?? name;
    } else {
      const fo = await this.folders.findOne({
        where: { id: share.targetId },
        select: { name: true },
      });
      name = fo?.name ?? name;
    }
    return {
      targetType: share.targetType,
      name,
      permission: share.permission,
      requiresPassword: !!share.passwordHash,
    };
  }

  private async verifySharePassword(
    share: DriveShareEntity,
    password?: string,
  ): Promise<void> {
    if (!share.passwordHash) return;
    const ok = password
      ? await bcrypt.compare(password, share.passwordHash)
      : false;
    if (!ok) {
      throw new ForbiddenException({
        code: 'SHARE_PASSWORD_REQUIRED',
        message: 'Incorrect or missing password.',
      });
    }
  }

  async openShare(token: string, password?: string): Promise<DriveShareEntity> {
    const share = await this.resolveShare(token);
    await this.verifySharePassword(share, password);
    share.accessCount += 1;
    share.lastAccessedAt = new Date();
    await this.shares.save(share);
    return share;
  }

  async listShareFolder(
    token: string,
    password: string | undefined,
    folderId: string | null,
  ): Promise<{
    breadcrumb: Array<{ _id: string; name: string }>;
    folders: Array<{ _id: string; name: string }>;
    files: Array<{ _id: string; name: string; sizeBytes: number; contentType: string }>;
  }> {
    const share = await this.resolveShare(token);
    await this.verifySharePassword(share, password);
    if (share.targetType !== 'folder') {
      throw new BadRequestException('Not a folder share');
    }

    const allowed = await this.collectSubtreeFolderIds(
      share.organizationId,
      share.targetId,
    );
    const allowedSet = new Set(allowed);
    const target = folderId || share.targetId;
    if (!allowedSet.has(target)) {
      throw new ForbiddenException('Outside shared folder');
    }

    const [folders, files] = await Promise.all([
      this.folders.find({
        where: {
          organizationId: share.organizationId,
          parentFolderId: target,
          isDeleted: false,
        },
        order: { name: 'ASC' },
      }),
      this.files.find({
        where: {
          organizationId: share.organizationId,
          folderId: target,
          isDeleted: false,
        },
        order: { name: 'ASC' },
      }),
    ]);

    const breadcrumb: Array<{ _id: string; name: string }> = [];
    let cur: string | null = target;
    for (let i = 0; i < 64 && cur && allowedSet.has(cur); i++) {
      const fo: DriveFolderEntity | null = await this.folders.findOne({
        where: { id: cur },
      });
      if (!fo) break;
      breadcrumb.unshift({ _id: fo.id, name: fo.name });
      cur = cur === share.targetId ? null : fo.parentFolderId;
    }

    return {
      breadcrumb,
      folders: folders.map((f) => ({ _id: f.id, name: f.name })),
      files: files.map((f) => ({
        _id: f.id,
        name: f.name,
        sizeBytes: f.size,
        contentType: f.mimeType,
      })),
    };
  }

  /**
   * Resolve a file reachable through a share to an authenticated byte STREAM.
   * Unlike the legacy module (which returned a presigned S3 URL), the public
   * share endpoint streams bytes through the server, matching the app's
   * private-byte posture.
   */
  async getShareDownloadStream(
    token: string,
    password: string | undefined,
    fileId: string,
  ): Promise<{
    stream: Readable;
    mimeType: string;
    filename: string;
    size: number | null;
    permission: 'view' | 'download';
  }> {
    const share = await this.resolveShare(token);
    await this.verifySharePassword(share, password);

    const resolvedId = share.targetType === 'file' ? share.targetId : fileId;
    const file = await this.files.findOne({
      where: {
        id: resolvedId,
        organizationId: share.organizationId,
        isDeleted: false,
      },
    });
    if (!file) throw new NotFoundException('File not found');

    if (share.targetType === 'folder') {
      const allowed = new Set(
        await this.collectSubtreeFolderIds(share.organizationId, share.targetId),
      );
      if (!file.folderId || !allowed.has(String(file.folderId))) {
        throw new ForbiddenException('Outside shared folder');
      }
    }

    const meta = await this.storage.getMeta(file.storageFileId);
    const opened = await this.storage.openStream(meta);
    return {
      stream: opened.stream,
      mimeType: opened.mimeType,
      filename: file.name || opened.filename,
      size: opened.size,
      permission: share.permission,
    };
  }
}
