import {
  Body,
  Controller,
  Get,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { VerticalAdminGuard } from './guards/vertical-admin.guard';
import { VerticalPackService } from './vertical-pack.service';
import { SetVerticalPackDto } from './dto';

/**
 * Vertical pack (`/api/v1/vertical`) — §04/§12. GET resolves the caller's org
 * pack (vocabulary, enabled modules, AI tier ceiling) and is readable by any
 * authenticated member (the UI needs its vocabulary). PUT sets the org's
 * orgType/override and is owner/admin only (VerticalAdminGuard). The org is
 * always the JWT's own — never taken from the client.
 */
@Controller('vertical')
export class VerticalController {
  constructor(private readonly vertical: VerticalPackService) {}

  private orgId(req: any): string {
    const id = req.user?.organizationId;
    if (!id) throw new Error('No organization context');
    return id;
  }

  /** The resolved effective pack for the caller's org. */
  @Get('pack')
  @UseGuards(JwtAuthGuard)
  async getPack(@Req() req: any) {
    const data = await this.vertical.resolvePack(this.orgId(req));
    return { success: true, data };
  }

  /** Admin: set the org's orgType and/or per-org pack override. */
  @Put()
  @UseGuards(JwtAuthGuard, VerticalAdminGuard)
  async setPack(@Body() dto: SetVerticalPackDto, @Req() req: any) {
    const data = await this.vertical.setPack(
      this.orgId(req),
      dto,
      req.user.userId,
    );
    return { success: true, data };
  }
}
