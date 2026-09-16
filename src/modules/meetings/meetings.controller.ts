import { Body, Controller, ForbiddenException, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ModuleEnabledGuard, RequireModule } from '../vertical/guards/module-enabled.guard';
import { MeetingCaller, MeetingsService } from './meetings.service';
import { AddMeetingParticipantsDto, CreateMeetingDto, InstantMeetingDto, UpdateMeetingDto } from './dto';

/**
 * Video meetings — `/api/v1/meetings/*`. JWT-guarded, org-scoped, and gated on
 * the `meetings` module being enabled for the org. The acting org + user always
 * come from `req.user`.
 */
@Controller('meetings')
@UseGuards(JwtAuthGuard, ModuleEnabledGuard)
@RequireModule('meetings')
export class MeetingsController {
  constructor(private readonly meetings: MeetingsService) {}

  private orgId(req: any): string {
    const id = req.user?.organizationId;
    if (!id) throw new ForbiddenException('No organization context');
    return id;
  }
  private caller(req: any): MeetingCaller {
    return {
      userId: req.user?.userId,
      isAdmin: req.user?.orgRole === 'owner' || req.user?.orgRole === 'admin',
    };
  }

  /** Schedule a meeting. */
  @Post()
  async create(@Req() req: any, @Body() dto: CreateMeetingDto) {
    return { success: true, data: await this.meetings.create(this.orgId(req), this.caller(req), dto) };
  }

  /** Start a meeting now (returns join config). */
  @Post('instant')
  async instant(@Req() req: any, @Body() dto: InstantMeetingDto) {
    return { success: true, data: await this.meetings.instant(this.orgId(req), this.caller(req), dto) };
  }

  /** The caller's accessible meetings (host or invited; admins see all). */
  @Get()
  async list(@Req() req: any) {
    return { success: true, data: await this.meetings.list(this.orgId(req), this.caller(req)) };
  }

  /** Meetings the caller is invited to and can join right now (for the join popup). */
  @Get('incoming')
  async incoming(@Req() req: any) {
    return { success: true, data: await this.meetings.incoming(this.orgId(req), this.caller(req)) };
  }

  /** Remember the join prompt was handled (joined / dismissed) for this user. */
  @Post(':id/notice')
  async notice(@Req() req: any, @Param('id') id: string, @Body() body: { action?: string }) {
    const action = body?.action === 'joined' ? 'joined' : 'dismissed';
    return { success: true, data: await this.meetings.markNotice(this.orgId(req), this.caller(req), id, action) };
  }

  @Get(':id')
  async get(@Req() req: any, @Param('id') id: string) {
    return { success: true, data: await this.meetings.get(this.orgId(req), this.caller(req), id) };
  }

  @Patch(':id')
  async update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateMeetingDto) {
    return { success: true, data: await this.meetings.update(this.orgId(req), this.caller(req), id, dto) };
  }

  /** Get the Jitsi room config to join (flips a scheduled meeting live). */
  @Post(':id/join')
  async join(@Req() req: any, @Param('id') id: string) {
    return { success: true, data: await this.meetings.join(this.orgId(req), this.caller(req), id) };
  }

  /** Add people to a meeting (host only) — pull others into an ongoing call. */
  @Post(':id/participants')
  async addParticipants(@Req() req: any, @Param('id') id: string, @Body() dto: AddMeetingParticipantsDto) {
    return { success: true, data: await this.meetings.addParticipants(this.orgId(req), this.caller(req), id, dto.userIds) };
  }

  @Post(':id/cancel')
  async cancel(@Req() req: any, @Param('id') id: string) {
    return { success: true, data: await this.meetings.cancel(this.orgId(req), this.caller(req), id) };
  }

  @Post(':id/end')
  async end(@Req() req: any, @Param('id') id: string) {
    return { success: true, data: await this.meetings.end(this.orgId(req), this.caller(req), id) };
  }
}
