import { Controller, ForbiddenException, Get, Query, Req, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ModuleEnabledGuard, RequireModule } from '../vertical/guards/module-enabled.guard';
import { CalendarCaller, CalendarService } from './calendar.service';

/**
 * Unified calendar feed — `GET /api/v1/calendar?from=&to=`. Org-scoped, gated on
 * the `calendar` module. Combines holidays, approved leave, the caller's
 * meetings, and team birthdays for the window.
 */
@Controller('calendar')
@UseGuards(JwtAuthGuard, ModuleEnabledGuard)
@RequireModule('calendar')
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  private orgId(req: any): string {
    const id = req.user?.organizationId;
    if (!id) throw new ForbiddenException('No organization context');
    return id;
  }
  private caller(req: any): CalendarCaller {
    return { userId: req.user?.userId, isAdmin: req.user?.orgRole === 'owner' || req.user?.orgRole === 'admin' };
  }

  @Get()
  async events(@Req() req: any, @Query('from') from?: string, @Query('to') to?: string) {
    // Default to the current month when no window is given.
    const now = new Date();
    const start = from ? new Date(from) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = to ? new Date(to) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59));
    const data = await this.calendar.getEvents(this.orgId(req), this.caller(req), start, end);
    return { success: true, data };
  }
}
