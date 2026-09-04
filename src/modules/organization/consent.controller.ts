import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OrganizationService } from './services/organization.service';
import { TermsService } from '../terms/terms.service';

/**
 * Owner-facing consent surface. Reachable by an org owner/admin REGARDLESS of
 * consent state or status — this is where a not-yet-consented org accepts the
 * Terms & Conditions. Effective paths: `GET /api/v1/consent`,
 * `POST /api/v1/consent/accept`.
 */
@Controller('consent')
@UseGuards(JwtAuthGuard)
export class ConsentController {
  constructor(
    private readonly orgService: OrganizationService,
    private readonly terms: TermsService,
  ) {}

  private requireOrgAdmin(req: any): string {
    const orgId = req.user.organizationId;
    if (!orgId) throw new ForbiddenException('No organization context');
    if (req.user.orgRole !== 'owner' && req.user.orgRole !== 'admin') {
      throw new ForbiddenException(
        'Only an organization owner or admin can accept the terms',
      );
    }
    return orgId;
  }

  @Get()
  async state(@Req() req: any) {
    return {
      success: true,
      data: await this.orgService.getConsentState(this.requireOrgAdmin(req)),
    };
  }

  /**
   * Stream the current terms PDF (when the current terms are a PDF) so the owner
   * can read it on the consent screen. Any org owner/admin may read the platform
   * terms document, regardless of org — not the org-scoped `/media` access check.
   */
  @Get('document')
  async document(@Req() req: any, @Res() res: Response) {
    const orgId = this.requireOrgAdmin(req);
    const termsId = await this.orgService.getAssignedTermsId(orgId);
    if (!termsId) {
      throw new NotFoundException('No Terms & Conditions assigned to this organization');
    }
    const { buffer, mimeType, filename } = await this.terms.getDocumentBytes(termsId);
    const safeName = filename.replace(/[^\w.\-]+/g, '_');
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buffer);
  }

  @Post('accept')
  async accept(@Req() req: any) {
    const ip =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.ip;
    const ua = req.headers['user-agent'] as string;
    const data = await this.orgService.acceptConsent(
      this.requireOrgAdmin(req),
      req.user.userId,
      ip,
      ua,
    );
    return { success: true, message: 'Terms accepted', data };
  }
}
