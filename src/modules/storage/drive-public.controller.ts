import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { DriveService } from './drive.service';
import { ListShareDto, OpenShareDto, ShareDownloadDto } from './dto';

/**
 * Public share API — reachable WITHOUT a Nexora login, for clients outside the
 * org. This controller applies NO JwtAuthGuard (the app guards per-controller, so
 * an unguarded controller is public). The org context is NEVER taken from the
 * caller; it is read from the share row the opaque token resolves to.
 *
 *   GET  /api/v1/storage/share/:token            safe metadata (no contents)
 *   POST /api/v1/storage/share/:token/open       validate password, bump counter
 *   POST /api/v1/storage/share/:token/list       list a folder in the subtree
 *   POST /api/v1/storage/share/:token/download   stream one file's bytes
 *
 * Password is sent in the POST body (not the URL) so it never lands in
 * server/proxy access logs. Downloads stream through the authenticated
 * server-side proxy (never a presigned URL), matching the app's byte posture.
 */
@Controller('storage/share')
export class DrivePublicController {
  constructor(private readonly drive: DriveService) {}

  @Get(':token')
  async info(@Param('token') token: string) {
    return this.drive.getShareInfo(token);
  }

  @Post(':token/open')
  async open(@Param('token') token: string, @Body() body: OpenShareDto) {
    const share = await this.drive.openShare(token, body?.password);
    return {
      ok: true,
      targetType: share.targetType,
      permission: share.permission,
    };
  }

  @Post(':token/list')
  async list(@Param('token') token: string, @Body() body: ListShareDto) {
    return this.drive.listShareFolder(token, body?.password, body?.folderId || null);
  }

  @Post(':token/download')
  async download(
    @Param('token') token: string,
    @Body() body: ShareDownloadDto,
    @Res() res: Response,
  ) {
    if (!body?.fileId) throw new BadRequestException('fileId is required');
    const f = await this.drive.getShareDownloadStream(
      token,
      body?.password,
      body.fileId,
    );
    res.setHeader('Content-Type', f.mimeType || 'application/octet-stream');
    if (f.size) res.setHeader('Content-Length', String(f.size));
    const safe = f.filename.replace(/["\r\n]/g, '_');
    // 'view' shares preview inline; 'download' shares force a save dialog.
    const disposition = f.permission === 'download' ? 'attachment' : 'inline';
    res.setHeader('Content-Disposition', `${disposition}; filename="${safe}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    f.stream.pipe(res);
  }
}
