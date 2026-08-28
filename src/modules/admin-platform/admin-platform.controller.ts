import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import { AdminPlatformService } from './admin-platform.service';

/**
 * Platform usage overview for the super admin. Effective path (global prefix):
 * `GET /api/v1/admin/platform/usage`. Super-admin only (PlatformAdminGuard) —
 * these are cross-tenant aggregates no org member may see.
 */
@Controller('admin/platform')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class AdminPlatformController {
  constructor(private readonly platform: AdminPlatformService) {}

  @Get('usage')
  async usage() {
    const data = await this.platform.getUsage();
    return { success: true, data };
  }
}
