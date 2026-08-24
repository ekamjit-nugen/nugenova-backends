import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../auth/guards/platform-admin.guard';
import { TermsService } from '../terms/terms.service';
import { UpdateTermsDto } from './dto';

/**
 * Super-admin management of the global Terms & Conditions. Editing bumps the
 * version, which forces every org to re-accept. Effective paths:
 * `GET /api/v1/admin/terms`, `PUT /api/v1/admin/terms`.
 */
@Controller('admin/terms')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class AdminTermsController {
  constructor(private readonly terms: TermsService) {}

  @Get()
  async get() {
    const current = await this.terms.getCurrent();
    return {
      success: true,
      data: {
        version: current.version,
        text: current.text,
        updatedAt: current.updatedAt,
      },
    };
  }

  @Put()
  async update(@Body() dto: UpdateTermsDto, @Req() req: any) {
    const current = await this.terms.update(dto.text, req.user.userId);
    return {
      success: true,
      message: `Terms & Conditions updated to v${current.version} — all organizations must re-accept`,
      data: { version: current.version },
    };
  }
}
