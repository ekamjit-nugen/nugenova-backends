import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PushService } from './push.service';

export class RegisterPushTokenDto {
  @IsString() @MaxLength(4096) token: string;
  @IsOptional() @IsIn(['web', 'android', 'ios']) platform?: string;
}
export class UnregisterPushTokenDto {
  @IsString() @MaxLength(4096) token: string;
}

/** `/api/v1/push` — real-time push (FCM) subscriptions for the signed-in user. */
@Controller('push')
@UseGuards(JwtAuthGuard)
export class PushController {
  constructor(private readonly push: PushService) {}

  /** Firebase web config + Web Push key the browser needs to subscribe. */
  @Get('config')
  config() {
    return { success: true, data: this.push.webConfig() };
  }

  @Post('tokens')
  @HttpCode(HttpStatus.NO_CONTENT)
  async register(@Req() req: any, @Body() dto: RegisterPushTokenDto) {
    await this.push.register(req.user.userId, req.user.organizationId ?? null, dto.token, dto.platform ?? 'web', req.headers?.['user-agent'] ?? null);
  }

  @Delete('tokens')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unregister(@Req() req: any, @Body() dto: UnregisterPushTokenDto) {
    await this.push.unregister(req.user.userId, dto.token);
  }
}
