import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ChatSettingsService } from './services/chat-settings.service';
import { UpdateChatSettingsDto } from './dto';

/**
 * Org chat policy. Any member may READ the effective settings (so the client can
 * reflect them — hide the attach button, disable a locked composer, etc.), but
 * only an org owner/admin may WRITE them. The acting org always comes from
 * req.user, never the body.
 */
@Controller('chat')
@UseGuards(JwtAuthGuard)
export class ChatSettingsController {
  constructor(private readonly settings: ChatSettingsService) {}

  private orgId(req: any): string {
    const id = req.user?.organizationId;
    if (!id) throw new ForbiddenException('No organization context');
    return id;
  }

  @Get('settings')
  async get(@Req() req: any) {
    const data = await this.settings.load(this.orgId(req));
    return { success: true, data };
  }

  @Put('settings')
  async update(@Body() dto: UpdateChatSettingsDto, @Req() req: any) {
    if (!this.settings.isAdmin(req.user?.orgRole)) {
      throw new ForbiddenException('Only an org admin can change chat settings.');
    }
    const data = await this.settings.update(this.orgId(req), dto);
    return { success: true, message: 'Chat settings updated', data };
  }
}
