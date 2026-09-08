import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import { OrgLimitsService } from './services/org-limits.service';
import { UpdatePlatformSettingsDto } from './dto';

/**
 * Platform-wide DEFAULTS the super admin controls (effective paths under the
 * global prefix): `GET/PUT /api/v1/admin/platform/settings`. These seed a new
 * org's storage allocation and act as the fallback seat cap. Super-admin only.
 *
 * NOTE: shares the `admin/platform` path prefix with `AdminPlatformController`
 * (which owns `…/usage`); distinct sub-routes, no collision.
 */
@Controller('admin/platform')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class AdminPlatformSettingsController {
  constructor(private readonly limits: OrgLimitsService) {}

  @Get('settings')
  async get() {
    const data = await this.limits.getPlatformDefaults();
    return { success: true, data };
  }

  @Put('settings')
  @HttpCode(HttpStatus.OK)
  async set(@Body() dto: UpdatePlatformSettingsDto, @Req() req: any) {
    const data = await this.limits.setPlatformDefaults(dto, req.user.userId);
    return { success: true, message: 'Platform defaults updated', data };
  }
}
