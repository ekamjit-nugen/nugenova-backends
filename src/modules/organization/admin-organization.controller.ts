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
}
