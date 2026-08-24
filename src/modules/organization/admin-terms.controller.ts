import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Put,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import { TermsService, PLATFORM_ORG_ID } from '../terms/terms.service';
import { StorageService } from '../../bootstrap/storage/storage.service';
import { UpdateTermsDto, PublishPdfTermsDto } from './dto';

/**
 * Super-admin management of the global Terms & Conditions. Publishing (HTML from
 * a template/editor, or an uploaded PDF) bumps the version, which forces every
 * org to re-accept. Effective paths (global prefix `api/v1`):
 * `GET /admin/terms`, `GET /admin/terms/templates`, `PUT /admin/terms`,
 * `POST /admin/terms/pdf`, `GET /admin/terms/document`.
 */
@Controller('admin/terms')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class AdminTermsController {
  constructor(
    private readonly terms: TermsService,
    private readonly storage: StorageService,
  ) {}

  @Get()
  async get() {
    const current = await this.terms.getCurrent();
    return {
      success: true,
      data: {
        version: current.version,
        kind: current.kind,
        text: current.text,
        title: current.title,
        fileId: current.fileId,
        hasDocument: current.kind === 'pdf' && !!current.fileId,
        updatedAt: current.updatedAt,
      },
    };
  }

  /** The ready-made templates the editor offers as starting points. */
  @Get('templates')
  templates() {
    return { success: true, data: this.terms.listTemplates() };
  }

  @Put()
  async update(@Body() dto: UpdateTermsDto, @Req() req: any) {
    const current = await this.terms.publishHtml(
      dto.text,
      dto.title ?? null,
      req.user.userId,
    );
    return {
      success: true,
      message: `Terms & Conditions updated to v${current.version} — all organizations must re-accept`,
      data: { version: current.version, kind: current.kind },
    };
  }

  /** Upload a PDF and publish it as the new terms version. */
  @Post('pdf')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024 } }),
  )
  async publishPdf(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: PublishPdfTermsDto,
    @Req() req: any,
  ) {
    if (!file) throw new BadRequestException('No PDF provided');
    if (file.mimetype !== 'application/pdf') {
      throw new BadRequestException('The terms document must be a PDF');
    }
    const meta = await this.storage.save({
      organizationId: PLATFORM_ORG_ID,
      originalName: file.originalname,
      mimeType: file.mimetype,
      buffer: file.buffer,
      uploadedBy: req.user.userId,
      category: 'platform-terms',
    });
    const current = await this.terms.publishPdf(
      meta.id,
      dto.title || file.originalname,
      req.user.userId,
    );
    return {
      success: true,
      message: `Terms & Conditions updated to v${current.version} (PDF) — all organizations must re-accept`,
      data: { version: current.version, kind: current.kind, fileId: current.fileId },
    };
  }

  /** Stream the current terms PDF for the super-admin preview. */
  @Get('document')
  async document(@Res() res: Response) {
    const { buffer, mimeType, filename } = await this.terms.getDocumentBytes();
    const safeName = filename.replace(/[^\w.\-]+/g, '_');
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.send(buffer);
  }
}
