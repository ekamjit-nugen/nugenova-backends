import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import { TermsService, PLATFORM_ORG_ID } from '../terms/terms.service';
import { StorageService } from '../../bootstrap/storage/storage.service';
import { OrganizationService } from './services/organization.service';
import { UpsertHtmlTermsDto, UpsertPdfTermsDto } from './dto';

/**
 * Super-admin management of the Terms & Conditions **library**. The super admin
 * creates named T&C documents (HTML from a template/editor, or an uploaded PDF),
 * edits them (bumping their version → assigned orgs must re-accept), and deletes
 * them (blocked while an org still uses one). Effective paths (`api/v1`):
 * `GET/POST /admin/terms`, `GET /admin/terms/templates`, `POST /admin/terms/pdf`,
 * `GET/PUT/DELETE /admin/terms/:id`, `PUT /admin/terms/:id/pdf`,
 * `GET /admin/terms/:id/document`.
 */
@Controller('admin/terms')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class AdminTermsController {
  constructor(
    private readonly terms: TermsService,
    private readonly storage: StorageService,
    private readonly orgService: OrganizationService,
  ) {}

  /** List every T&C document in the library. */
  @Get()
  async list() {
    return { success: true, data: await this.terms.list() };
  }

  /** The ready-made templates the editor offers as starting points. */
  @Get('templates')
  templates() {
    return { success: true, data: this.terms.listTemplates() };
  }

  /** Create a new HTML T&C document. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: UpsertHtmlTermsDto, @Req() req: any) {
    const doc = await this.terms.create(
      { kind: 'html', title: dto.title, text: dto.text },
      req.user.userId,
    );
    if (doc.isActive) void this.orgService.notifyOwnersTermsUpdated(req.user.userId);
    return { success: true, message: 'Terms & Conditions created', data: doc };
  }

  /** Create a new PDF T&C document (multipart `file` + `title`). */
  @Post('pdf')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024 } }),
  )
  async createPdf(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UpsertPdfTermsDto,
    @Req() req: any,
  ) {
    const fileId = await this.storePdf(file, req.user.userId);
    const doc = await this.terms.create(
      { kind: 'pdf', title: dto.title || file.originalname, fileId },
      req.user.userId,
    );
    if (doc.isActive) void this.orgService.notifyOwnersTermsUpdated(req.user.userId);
    return { success: true, message: 'Terms & Conditions created', data: doc };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return { success: true, data: await this.terms.get(id) };
  }

  /** Make this document THE active platform T&C — every org must re-accept it. */
  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  async activate(@Param('id') id: string, @Req() req: any) {
    const doc = await this.terms.activate(id);
    // Tell every org's owner/admin to re-accept (in-app + email).
    void this.orgService.notifyOwnersTermsUpdated(req.user.userId);
    return {
      success: true,
      message: 'Now the active Terms & Conditions — all organizations must accept it',
      data: doc,
    };
  }

  /** Edit an HTML T&C — bumps its version; assigned orgs must re-accept. */
  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpsertHtmlTermsDto,
    @Req() req: any,
  ) {
    const doc = await this.terms.update(
      id,
      { kind: 'html', title: dto.title, text: dto.text },
      req.user.userId,
    );
    if (doc.isActive) void this.orgService.notifyOwnersTermsUpdated(req.user.userId);
    return {
      success: true,
      message: `Terms updated to v${doc.version} — all organizations must re-accept`,
      data: doc,
    };
  }

  /** Replace a T&C's PDF (multipart) — bumps its version. */
  @Put(':id/pdf')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024 } }),
  )
  async updatePdf(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UpsertPdfTermsDto,
    @Req() req: any,
  ) {
    const fileId = await this.storePdf(file, req.user.userId);
    const doc = await this.terms.update(
      id,
      { kind: 'pdf', title: dto.title || file.originalname, fileId },
      req.user.userId,
    );
    if (doc.isActive) void this.orgService.notifyOwnersTermsUpdated(req.user.userId);
    return {
      success: true,
      message: `Terms updated to v${doc.version} — all organizations must re-accept`,
      data: doc,
    };
  }

  /** Delete a T&C — refused for the active document (every org depends on it). */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async remove(@Param('id') id: string) {
    if (this.terms.isActiveTerms(id)) {
      throw new ConflictException(
        'Cannot delete the active Terms & Conditions. Activate a different one first.',
      );
    }
    await this.terms.remove(id);
    return { success: true, message: 'Terms & Conditions deleted' };
  }

  /** Stream a T&C's PDF for the super-admin preview. */
  @Get(':id/document')
  async document(@Param('id') id: string, @Res() res: Response) {
    const { buffer, mimeType, filename } = await this.terms.getDocumentBytes(id);
    const safeName = filename.replace(/[^\w.\-]+/g, '_');
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buffer);
  }

  private async storePdf(
    file: Express.Multer.File,
    userId: string,
  ): Promise<string> {
    if (!file) throw new BadRequestException('No PDF provided');
    if (file.mimetype !== 'application/pdf') {
      throw new BadRequestException('The terms document must be a PDF');
    }
    const meta = await this.storage.save({
      organizationId: PLATFORM_ORG_ID,
      originalName: file.originalname,
      mimeType: file.mimetype,
      buffer: file.buffer,
      uploadedBy: userId,
      category: 'platform-terms',
    });
    return meta.id;
  }
}
