import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import { OrganizationService } from './services/organization.service';
import { OrgLimitsService } from './services/org-limits.service';
import { VerticalPackService } from '../vertical/vertical-pack.service';
import { CreateOrganizationDto, SetOrgModulesDto, UpdateOrgLimitsDto } from './dto';

/**
 * Platform-admin organization provisioning. Effective paths (global prefix):
 * `POST/GET /api/v1/admin/organizations`, `GET /api/v1/admin/organizations/:id`.
 * Guarded to super-admin only.
 */
@Controller('admin/organizations')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class AdminOrganizationController {
  constructor(
    private readonly orgService: OrganizationService,
    private readonly limits: OrgLimitsService,
    private readonly vertical: VerticalPackService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateOrganizationDto, @Req() req: any) {
    const data = await this.orgService.createOrganization(dto, req.user.userId);
    return { success: true, message: 'Organization created', data };
  }

  @Get()
  async list() {
    const data = await this.orgService.list();
    return { success: true, data };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const data = await this.orgService.get(id);
    return { success: true, data };
  }

  /** Account/security/setup insights for one org (no tenant business data). */
  @Get(':id/insights')
  async insights(@Param('id') id: string) {
    const data = await this.orgService.getInsights(id);
    return { success: true, data };
  }

  /** Manually halt an org (conditions not met) — its owner is fully blocked. */
  @Post(':id/halt')
  @HttpCode(HttpStatus.OK)
  async halt(@Param('id') id: string, @Req() req: any) {
    const data = await this.orgService.halt(id, req.user.userId);
    return { success: true, message: 'Organization halted', data };
  }

  /** Lift a halt — the org is active again (consent still required if stale). */
  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  async reactivate(@Param('id') id: string, @Req() req: any) {
    const data = await this.orgService.reactivate(id, req.user.userId);
    return { success: true, message: 'Organization reactivated', data };
  }

  /** Re-send the owner's invitation email. */
  @Post(':id/resend-invite')
  @HttpCode(HttpStatus.OK)
  async resendInvite(@Param('id') id: string, @Req() req: any) {
    const data = await this.orgService.resendInvite(id, req.user.userId);
    return {
      success: true,
      message: `Invitation re-sent to ${data.email}`,
      data,
    };
  }

  /**
   * Per-org limits + live usage: storage allocation (Team-Drive GB, default
   * per-user My-Drive GB) and the member seat cap, with current usage/counts.
   */
  @Get(':id/limits')
  async getLimits(@Param('id') id: string) {
    const data = await this.limits.getOrgLimits(id);
    return { success: true, data };
  }

  /**
   * The org's enabled modules: the effective list, whether it's been explicitly
   * configured, and the org type. The module catalog/labels live on the client.
   */
  @Get(':id/modules')
  async getModules(@Param('id') id: string) {
    const pack = await this.vertical.resolvePack(id);
    return {
      success: true,
      data: {
        orgType: pack.orgType,
        enabledModules: pack.enabledModules,
        configured: pack.modulesConfigured,
      },
    };
  }

  /** Set which modules this org can see/access. Empty list = all modules on. */
  @Put(':id/modules')
  @HttpCode(HttpStatus.OK)
  async setModules(@Param('id') id: string, @Body() dto: SetOrgModulesDto, @Req() req: any) {
    const pack = await this.vertical.setEnabledModules(id, dto.modules, req.user.userId);
    return {
      success: true,
      message: 'Organization modules updated',
      data: { orgType: pack.orgType, enabledModules: pack.enabledModules, configured: pack.modulesConfigured },
    };
  }

  /** Set this org's storage allocation and/or member seat cap. */
  @Put(':id/limits')
  @HttpCode(HttpStatus.OK)
  async setLimits(
    @Param('id') id: string,
    @Body() dto: UpdateOrgLimitsDto,
    @Req() req: any,
  ) {
    const data = await this.limits.setOrgLimits(id, dto, req.user.userId);
    return { success: true, message: 'Organization limits updated', data };
  }
}
