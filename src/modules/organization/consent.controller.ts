import {
  Controller,
  ForbiddenException,
  Get,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OrganizationService } from './services/organization.service';

/**
 * Owner-facing consent surface. Reachable by an org owner/admin REGARDLESS of
 * consent state or status — this is where a not-yet-consented org accepts the
 * Terms & Conditions. Effective paths: `GET /api/v1/consent`,
 * `POST /api/v1/consent/accept`.
 */
@Controller('consent')
@UseGuards(JwtAuthGuard)
export class ConsentController {
  constructor(private readonly orgService: OrganizationService) {}

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
