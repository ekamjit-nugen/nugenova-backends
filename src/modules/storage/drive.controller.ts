import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DriveAdminGuard } from './drive-admin.guard';
import { DriveService } from './drive.service';
import { CloudDriveAccessGuard } from './cloud-drive-access.guard';
import type { DriveScope } from './entities/drive-folder.entity';
import {
  CreateFolderDto,
  CreateShareDto,
  MoveFileDto,
  MoveFolderDto,
  RenameFileDto,
  RenameFolderDto,
  SetAccessDto,
  SetSettingsDto,
} from './dto';

function parseScope(raw: any): DriveScope {
  return raw === 'personal' ? 'personal' : 'team';
}

/**
 * Cloud Drive HTTP API (authenticated). Every route requires a valid JWT AND
 * drive access (CloudDriveAccessGuard) — except `access/me` (a lightweight nav
 * self-check) and the admin access-management routes (owner/admin/super_admin).
 * Mounted under `/api/v1/storage` (the media module owns `/media`).
 */
@Controller('storage')
@UseGuards(JwtAuthGuard)
export class DriveController {
  constructor(private readonly drive: DriveService) {}

  private displayName(req: any): string {
    return [req.user.firstName, req.user.lastName].filter(Boolean).join(' ');
  }

  // ─── Overview / quota ────────────────────────────────────────────

  /** Nav self-check: does the CURRENT user have drive access? (No access guard.) */
  @Get('access/me')
  async myAccess(@Req() req: any) {
    const enabled = await this.drive.canUseCloudDrive(
      req.user.organizationId,
      req.user.userId,
      req.user.orgRole,
      req.user.isPlatformAdmin,
    );
    return { enabled };
  }

  @Get('overview')
  @UseGuards(CloudDriveAccessGuard)
  async overview(@Req() req: any) {
    return this.drive.getDriveOverview(req.user.organizationId, req.user.userId);
  }

  @Get('quota')
  @UseGuards(CloudDriveAccessGuard)
  async getQuota(@Req() req: any) {
    return this.drive.getQuota(req.user.organizationId);
  }

  // ─── Folders ─────────────────────────────────────────────────────

  @Get('folders')
  @UseGuards(CloudDriveAccessGuard)
  async listFolders(
    @Req() req: any,
    @Query('scope') scope?: string,
    @Query('parentId') parentId?: string,
  ) {
    return this.drive.listFolders(
      req.user.organizationId,
      parseScope(scope),
      req.user.userId,
      parentId || null,
    );
  }

  @Get('folders/:id/breadcrumb')
  @UseGuards(CloudDriveAccessGuard)
  async breadcrumb(
    @Req() req: any,
    @Param('id') id: string,
    @Query('scope') scope?: string,
  ) {
    return this.drive.getBreadcrumb(
      req.user.organizationId,
      parseScope(scope),
      req.user.userId,
      id,
    );
  }

  @Post('folders')
  @UseGuards(CloudDriveAccessGuard)
  async createFolder(@Req() req: any, @Body() body: CreateFolderDto) {
    return this.drive.createFolder({
      organizationId: req.user.organizationId,
      userId: req.user.userId,
      userDisplayName: this.displayName(req),
      name: body.name,
      scope: parseScope(body.scope),
      parentId: body.parentId || null,
    });
  }

  @Patch('folders/:id')
  @UseGuards(CloudDriveAccessGuard)
  async renameFolder(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: RenameFolderDto,
  ) {
    return this.drive.renameFolder(
      req.user.organizationId,
      id,
      parseScope(body.scope),
      req.user.userId,
      body.name,
    );
  }

  @Patch('folders/:id/move')
  @UseGuards(CloudDriveAccessGuard)
  async moveFolder(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: MoveFolderDto,
  ) {
    return this.drive.moveFolder(
      req.user.organizationId,
      id,
      parseScope(body.scope),
      req.user.userId,
      body.targetParentId || null,
    );
  }

  @Delete('folders/:id')
  @UseGuards(CloudDriveAccessGuard)
  async deleteFolder(
    @Req() req: any,
    @Param('id') id: string,
    @Query('scope') scope?: string,
  ) {
    await this.drive.deleteFolder(
      req.user.organizationId,
      id,
      parseScope(scope),
      req.user.userId,
    );
    return { deleted: true };
  }

  // ─── Files ───────────────────────────────────────────────────────

  @Get('files')
  @UseGuards(CloudDriveAccessGuard)
  async list(
    @Req() req: any,
    @Query('scope') scope?: string,
    @Query('folderId') folderId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.drive.listFiles(
      req.user.organizationId,
      parseScope(scope),
      req.user.userId,
      folderId || null,
      page ? Number(page) : 1,
      limit ? Number(limit) : 50,
    );
  }

  @Post('files')
  @UseGuards(CloudDriveAccessGuard)
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @Req() req: any,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { scope?: string; folderId?: string; tags?: string },
  ) {
    if (!file) throw new BadRequestException('file is required');
    const tags = body?.tags
      ? body.tags.split(',').map((t) => t.trim()).filter(Boolean)
      : [];
    return this.drive.uploadFile({
      organizationId: req.user.organizationId,
      userId: req.user.userId,
      userDisplayName: this.displayName(req),
      name: file.originalname,
      scope: parseScope(body?.scope),
      folderId: body?.folderId || null,
      contentType: file.mimetype,
      body: file.buffer,
      tags,
    });
  }

  @Patch('files/:id')
  @UseGuards(CloudDriveAccessGuard)
  async renameFile(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: RenameFileDto,
  ) {
    return this.drive.renameFile(
      req.user.organizationId,
      id,
      parseScope(body.scope),
      req.user.userId,
      body.name,
    );
  }

  @Patch('files/:id/move')
  @UseGuards(CloudDriveAccessGuard)
  async moveFile(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: MoveFileDto,
  ) {
    return this.drive.moveFile(
      req.user.organizationId,
      id,
      parseScope(body.scope),
      req.user.userId,
      body.targetFolderId || null,
    );
  }

  /**
   * Stream the file INLINE through the API so the frontend renders it in an
   * in-app viewer — bytes served from the Nexora origin via StorageService, never
   * a public S3 URL. @Res() pipes binary directly, bypassing the JSON interceptor.
   */
  @Get('files/:id/raw')
  @UseGuards(CloudDriveAccessGuard)
  async raw(@Req() req: any, @Param('id') id: string, @Res() res: Response) {
    const f = await this.drive.getFileStream(req.user.organizationId, id);
    res.setHeader('Content-Type', f.mimeType || 'application/octet-stream');
    if (f.size) res.setHeader('Content-Length', String(f.size));
    const safe = f.filename.replace(/["\r\n]/g, '_');
    res.setHeader('Content-Disposition', `inline; filename="${safe}"`);
    res.setHeader('Cache-Control', 'private, max-age=60');
    f.stream.pipe(res);
  }

  /** Serve the file as PDF for high-fidelity in-app preview (PDFs pass through). */
  @Get('files/:id/pdf')
  @UseGuards(CloudDriveAccessGuard)
  async previewPdf(@Req() req: any, @Param('id') id: string, @Res() res: Response) {
    const f = await this.drive.getPreviewPdf(req.user.organizationId, id);
    res.setHeader('Content-Type', 'application/pdf');
    if (f.size) res.setHeader('Content-Length', String(f.size));
    const safe = f.name.replace(/["\r\n]/g, '_');
    res.setHeader('Content-Disposition', `inline; filename="${safe}"`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    f.stream.pipe(res);
  }

  @Delete('files/:id')
  @UseGuards(CloudDriveAccessGuard)
  async remove(
    @Req() req: any,
    @Param('id') id: string,
    @Query('scope') scope?: string,
  ) {
    await this.drive.deleteFile(
      req.user.organizationId,
      id,
      parseScope(scope),
      req.user.userId,
    );
    return { deleted: true };
  }

  // ─── External shares (management) ────────────────────────────────

  @Post('shares')
  @UseGuards(CloudDriveAccessGuard)
  async createShare(@Req() req: any, @Body() body: CreateShareDto) {
    const { token, share } = await this.drive.createShare({
      organizationId: req.user.organizationId,
      userId: req.user.userId,
      userDisplayName: this.displayName(req),
      targetType: body.targetType,
      targetId: body.targetId,
      scope: parseScope(body.scope),
      permission: body.permission,
      password: body.password,
      expiresAt: body.expiresAt,
    });
    return { token, shareId: share.id, permission: share.permission };
  }

  @Get('shares')
  @UseGuards(CloudDriveAccessGuard)
  async listShares(@Req() req: any) {
    return this.drive.listShares(req.user.organizationId, req.user.userId);
  }

  @Delete('shares/:id')
  @UseGuards(CloudDriveAccessGuard)
  async revokeShare(@Req() req: any, @Param('id') id: string) {
    await this.drive.revokeShare(req.user.organizationId, id, req.user.userId);
    return { revoked: true };
  }

  // ─── Admin: access management (platform admin) ───────────────────

  @Get('access')
  @UseGuards(DriveAdminGuard)
  async listAccess(@Req() req: any) {
    return this.drive.listAccess(req.user.organizationId);
  }

  @Put('access/:userId')
  @UseGuards(DriveAdminGuard)
  async setAccess(
    @Req() req: any,
    @Param('userId') userId: string,
    @Body() body: SetAccessDto,
  ) {
    if (typeof body?.enabled === 'boolean') {
      await this.drive.setUserAccess(
        req.user.organizationId,
        userId,
        body.enabled,
        req.user.userId,
      );
    }
    if (body?.quotaGb !== undefined) {
      await this.drive.setUserQuota(req.user.organizationId, userId, body.quotaGb);
    }
    return { ok: true };
  }

  @Put('settings')
  @UseGuards(DriveAdminGuard)
  async setSettings(@Req() req: any, @Body() body: SetSettingsDto) {
    await this.drive.setOrgStorageSettings(req.user.organizationId, body);
    return { ok: true };
  }
}
