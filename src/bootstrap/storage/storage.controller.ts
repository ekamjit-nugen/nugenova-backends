import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  BadRequestException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';

import { JwtAuthGuard } from '../../modules/auth/guards/jwt-auth.guard';
import { StorageService } from './storage.service';
import { DocumentFileEntity } from './document-file.entity';

/**
 * Generic authenticated file upload/download. Effective paths (global prefix):
 * `POST /api/v1/media/upload`, `GET /api/v1/media/files/:id`,
 * `GET /api/v1/media/files/:id/download`.
 *
 * Bytes are served only through the byte-proxy download (works identically for
 * the s3 and db drivers); the bucket/key are never exposed.
 */
@Controller('media')
@UseGuards(JwtAuthGuard)
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  @Post('upload')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024 } }),
  )
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ) {
    if (!file) throw new BadRequestException('No file provided');
    const orgId = req.user.organizationId;
    if (!orgId) throw new ForbiddenException('No organization context');
    const meta = await this.storage.save({
      organizationId: orgId,
      originalName: file.originalname,
      mimeType: file.mimetype,
      buffer: file.buffer,
      uploadedBy: req.user.userId,
      category: 'onboarding',
    });
    return { success: true, message: 'File uploaded', data: meta };
  }

  private assertCanAccess(file: DocumentFileEntity, req: any): void {
    if (req.user.isPlatformAdmin) return;
    if (file.uploadedBy && file.uploadedBy === req.user.userId) return;
    if (file.organizationId === req.user.organizationId) return;
    throw new ForbiddenException('You cannot access this file');
  }

  @Get('files/:id')
  async meta(@Param('id') id: string, @Req() req: any) {
    const file = await this.storage.getMeta(id);
    this.assertCanAccess(file, req);
    return { success: true, data: this.storage.toMeta(file) };
  }

  @Get('files/:id/download')
  async download(
    @Param('id') id: string,
    @Req() req: any,
    @Res() res: Response,
  ) {
    const file = await this.storage.getMeta(id);
    this.assertCanAccess(file, req);
    const bytes = await this.storage.getBytes(file);
    const safeName = file.originalName.replace(/[^\w.\-]+/g, '_');
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${safeName}"`,
    );
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(bytes);
  }
}
