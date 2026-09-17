import { Controller, ForbiddenException, Get, Post, Query, Req, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ModuleEnabledGuard, RequireModule } from '../vertical/guards/module-enabled.guard';
import { ActivityCaller, ActivityService } from './activity.service';
import { ActivityRetentionService } from './activity-retention.service';
import { ActivityCategory } from './entities/activity-event.entity';

/**
 * Activity feed — `/api/v1/activity`. JWT-guarded, org-scoped, gated on the
 * `activity` module. Admins/owners see the whole org; members see only their
 * own activity.
 */
@Controller('activity')
@UseGuards(JwtAuthGuard, ModuleEnabledGuard)
@RequireModule('activity')
export class ActivityController {
  constructor(
    private readonly activity: ActivityService,
    private readonly retention: ActivityRetentionService,
  ) {}

  private orgId(req: any): string {
    const id = req.user?.organizationId;
    if (!id) throw new ForbiddenException('No organization context');
    return id;
  }
  private caller(req: any): ActivityCaller {
    return { userId: req.user?.userId, isAdmin: req.user?.orgRole === 'owner' || req.user?.orgRole === 'admin' };
  }

  /** Org activity feed (members are auto-scoped to their own). */
  @Get()
  async list(
    @Req() req: any,
    @Query('scope') scope?: 'all' | 'me',
    @Query('actorId') actorId?: string,
    @Query('category') category?: ActivityCategory,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('area') area?: string,
  ) {
    const data = await this.activity.list(this.orgId(req), this.caller(req), {
      scope, actorId, category, from, to, area: area || undefined, page: page ? Number(page) : undefined, limit: limit ? Number(limit) : undefined,
    });
    return { success: true, ...data };
  }

  /** Error counts per area of the app (Recruitment, Attendance, …) for the Errors filter. */
  @Get('error-areas')
  async errorAreas(
    @Req() req: any,
    @Query('scope') scope?: 'all' | 'me',
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return { success: true, data: await this.activity.errorAreas(this.orgId(req), this.caller(req), { scope, from, to }) };
  }

  /** The caller's own activity. */
  @Get('me')
  async mine(
    @Req() req: any,
    @Query('category') category?: ActivityCategory,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const data = await this.activity.list(this.orgId(req), this.caller(req), {
      scope: 'me', category, from, to, page: page ? Number(page) : undefined, limit: limit ? Number(limit) : undefined,
    });
    return { success: true, ...data };
  }

  /** Owner/admin: back up + purge this org's logs now (skips the 15-day wait). */
  @Post('retention/run')
  async runRetention(@Req() req: any) {
    const caller = this.caller(req);
    if (!caller.isAdmin) throw new ForbiddenException('Only an owner or admin can run retention');
    const res = await this.retention.runForOrg(this.orgId(req), new Date(), true);
    return { success: true, data: res };
  }
}
