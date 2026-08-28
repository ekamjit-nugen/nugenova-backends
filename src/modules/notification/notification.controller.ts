import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NotificationService } from './notification.service';
import {
  NotificationPreferenceService,
  UpdatePreferenceInput,
} from './notification-preference.service';

/**
 * Notifications — the caller's own inbox. Guarded by JWT only: there is no
 * org-admin surface here because a notification is PERSONAL. The recipient is
 * always taken from the token (`req.user.userId`), never from a path/body param,
 * so every route reads and mutates only the caller's rows — a user can't touch
 * another user's notifications. Base path: `/api/v1/notifications`.
 */
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationController {
  constructor(
    private readonly notifications: NotificationService,
    private readonly preferences: NotificationPreferenceService,
  ) {}

  private userId(req: any): string {
    const uid = req.user?.userId;
    if (!uid) throw new ForbiddenException('Not authenticated');
    return uid;
  }

  private orgId(req: any): string | null {
    return req.user?.organizationId ?? null;
  }

  @Get()
  async list(
    @Query('limit') limit: string,
    @Query('before') before: string,
    @Query('unreadOnly') unreadOnly: string,
    @Req() req: any,
  ) {
    const page = await this.notifications.list(this.userId(req), {
      limit: limit ? Number(limit) : undefined,
      before: before || null,
      unreadOnly: unreadOnly === 'true' || unreadOnly === '1',
    });
    return { success: true, ...page };
  }

  @Get('unread-count')
  async unreadCount(@Req() req: any) {
    const count = await this.notifications.unreadCount(this.userId(req));
    return { success: true, data: { count } };
  }

  // ── preferences (Settings → Notifications) ──────────────────────────────────

  @Get('preferences')
  async getPreferences(@Req() req: any) {
    const data = await this.preferences.get(this.userId(req));
    return { success: true, data };
  }

  @Put('preferences')
  async updatePreferences(@Body() body: UpdatePreferenceInput, @Req() req: any) {
    const data = await this.preferences.update(this.userId(req), body || {});
    return { success: true, message: 'Preferences saved', data };
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  async markRead(@Param('id') id: string, @Req() req: any) {
    await this.notifications.markRead(id, this.userId(req));
    return { success: true, message: 'Marked read' };
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  async markAllRead(@Req() req: any) {
    const count = await this.notifications.markAllRead(this.userId(req));
    return { success: true, message: 'All marked read', data: { count } };
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: any) {
    await this.notifications.remove(id, this.userId(req));
    return { success: true, message: 'Dismissed' };
  }

  @Post('clear-read')
  @HttpCode(HttpStatus.OK)
  async clearRead(@Req() req: any) {
    const count = await this.notifications.clearRead(this.userId(req));
    return { success: true, message: 'Cleared read', data: { count } };
  }

  /**
   * Dev-only: seed one sample notification of a few types for the caller so the
   * panel + routing can be demonstrated without triggering real events. Blocked
   * in production.
   */
  @Post('seed-demo')
  @HttpCode(HttpStatus.CREATED)
  async seedDemo(@Req() req: any) {
    if (process.env.NODE_ENV === 'production') {
      throw new ForbiddenException('Not available in production');
    }
    const userId = this.userId(req);
    const organizationId = this.orgId(req) || '';
    const samples: Array<{
      type: string;
      title: string;
      body: string;
      data: Record<string, unknown>;
    }> = [
      {
        type: 'wfh_request_reviewed',
        title: 'WFH request approved',
        body: 'Your work-from-home request for Sep 2 was approved.',
        data: { actionUrl: '/attendance' },
      },
      {
        type: 'onboarding_initiated',
        title: 'Your onboarding has started',
        body: 'Complete your checklist and upload the required documents.',
        data: { actionUrl: '/onboarding/me' },
      },
      {
        type: 'policy_published',
        title: 'New policy to acknowledge',
        body: 'Please review and acknowledge the Work From Office policy.',
        data: { actionUrl: '/policies' },
      },
    ];
    for (const s of samples) {
      await this.notifications.create({ organizationId, userId, ...s });
    }
    return { success: true, message: 'Seeded sample notifications', data: { count: samples.length } };
  }
}
