import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import { AdminPlaybooksService } from './admin-playbooks.service';

/**
 * Super-admin-only migration playbooks. Effective paths (global prefix):
 * `GET /api/v1/admin/playbooks` and `GET /api/v1/admin/playbooks/:module`.
 * Guarded by JWT + platform-admin so only the super-admin account can read them.
 */
@Controller('admin/playbooks')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class AdminPlaybooksController {
  constructor(private readonly service: AdminPlaybooksService) {}

  @Get()
  async list() {
    const data = await this.service.list();
    return { success: true, data };
  }

  @Get(':module')
  async get(@Param('module') module: string) {
    const data = await this.service.get(module);
    return { success: true, data };
  }
}
