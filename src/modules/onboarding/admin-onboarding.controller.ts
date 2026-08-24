import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import { OnboardingService } from './services/onboarding.service';
import { DocumentTemplateService } from './services/document-template.service';
import {
  ApprovalDto,
  CreateTemplateDto,
  RejectionDto,
  RequestDocumentsDto,
} from './dto';

/**
 * Super-admin onboarding management. Effective paths (global prefix `/api/v1`):
 *   GET/POST/DELETE  /admin/document-templates
 *   POST             /admin/organizations/:orgId/documents        (request docs)
 *   GET              /admin/organizations/:orgId/onboarding       (status)
 *   POST             /admin/organizations/:orgId/activate
 *   POST             /admin/onboarding-documents/:id/approve|reject
 * Guarded to platform (super) admins only.
 */
@Controller('admin')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class AdminOnboardingController {
  constructor(
    private readonly onboarding: OnboardingService,
    private readonly templates: DocumentTemplateService,
  ) {}

  @Get('document-templates')
  async listTemplates() {
    return { success: true, data: await this.templates.list() };
  }

  @Post('document-templates')
  @HttpCode(HttpStatus.CREATED)
  async createTemplate(@Body() dto: CreateTemplateDto, @Req() req: any) {
    const data = await this.templates.create(dto, req.user.userId);
    return { success: true, message: 'Template created', data };
  }

  @Delete('document-templates/:id')
  async deleteTemplate(@Param('id') id: string) {
    await this.templates.remove(id);
    return { success: true, message: 'Template deleted' };
  }

  @Post('organizations/:orgId/documents')
  @HttpCode(HttpStatus.CREATED)
  async requestDocuments(
    @Param('orgId') orgId: string,
    @Body() dto: RequestDocumentsDto,
    @Req() req: any,
  ) {
    const data = await this.onboarding.requestDocuments(
      orgId,
      dto,
      req.user.userId,
    );
    return { success: true, message: 'Documents requested', data };
  }

  @Get('organizations/:orgId/onboarding')
  async onboardingStatus(@Param('orgId') orgId: string) {
    return { success: true, data: await this.onboarding.adminList(orgId) };
  }

  @Post('organizations/:orgId/activate')
  async activate(
    @Param('orgId') orgId: string,
    @Query('force') force: string,
    @Req() req: any,
  ) {
    const data = await this.onboarding.activateOrg(
      orgId,
      req.user.userId,
      force === 'true' || force === '1',
    );
    return { success: true, message: 'Organization activated', data };
  }

  @Post('onboarding-documents/:id/approve')
  async approve(
    @Param('id') id: string,
    @Body() dto: ApprovalDto,
    @Req() req: any,
  ) {
    const data = await this.onboarding.approveDocument(
      id,
      req.user.userId,
      dto.note,
    );
    return { success: true, message: 'Document approved', data };
  }

  @Post('onboarding-documents/:id/reject')
  async reject(
    @Param('id') id: string,
    @Body() dto: RejectionDto,
    @Req() req: any,
  ) {
    const data = await this.onboarding.rejectDocument(
      id,
      req.user.userId,
      dto.note,
    );
    return { success: true, message: 'Document rejected', data };
  }
}
