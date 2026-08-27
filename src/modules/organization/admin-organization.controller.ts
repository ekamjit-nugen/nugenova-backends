import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import { OrganizationService } from './services/organization.service';
import { CreateOrganizationDto } from './dto';

/**
 * Platform-admin organization provisioning. Effective paths (global prefix):
 * `POST/GET /api/v1/admin/organizations`, `GET /api/v1/admin/organizations/:id`.
 * Guarded to super-admin only.
 */
@Controller('admin/organizations')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class AdminOrganizationController {
  constructor(private readonly orgService: OrganizationService) {}

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
}
