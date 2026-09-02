import {
  Body,
  Controller,
  Delete,
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
import { AttendanceAccessGuard } from './guards/attendance-access.guard';
import { RequirePermission } from '../organization/guards/require-permission.decorator';
import { AttendanceService, Caller } from './services/attendance.service';
import { WfhRequestService } from './services/wfh-request.service';
import {
  ApproveEntryDto,
  AttendanceQueryDto,
  CheckInDto,
  CheckOutDto,
  CreateHolidayDto,
  HolidayQueryDto,
  ManualEntryDto,
  RequestEditDto,
  RequestWfhDto,
  ReviewEditDto,
  ReviewWfhDto,
  StatsQueryDto,
} from './dto';

/**
 * Attendance surface for the org the JWT is scoped to. Guarded by JWT +
 * AttendanceAccessGuard: routes WITHOUT `@RequirePermission` are self-service
 * (any active member); routes WITH it are org-wide (owner/admin or a permScoped
 * `attendance:*` role). Effective base paths: `/api/v1/attendance` + `/holidays`.
 */
@Controller()
@UseGuards(JwtAuthGuard, AttendanceAccessGuard)
export class AttendanceController {
  constructor(
    private readonly attendance: AttendanceService,
    private readonly wfh: WfhRequestService,
  ) {}

  private caller(req: any): Caller {
    const u = req.user;
    return {
      userId: u.userId,
      orgId: u.organizationId,
      roles: u.roles || [],
      orgRole: u.orgRole || null,
      perms: u.perms || null,
      permScoped: u.permScoped || false,
      departmentScopeId: u.departmentScopeId || null,
      ip: req.ip || req.headers?.['x-forwarded-for'] || null,
    };
  }

  // ── self-service (any active member) ────────────────────────────────────────

  @Post('attendance/check-in')
  @HttpCode(HttpStatus.CREATED)
  async checkIn(@Body() dto: CheckInDto, @Req() req: any) {
    const data = await this.attendance.checkIn(this.caller(req), dto);
    return { success: true, message: 'Clocked in', data };
  }

  @Post('attendance/check-out')
  @HttpCode(HttpStatus.OK)
  async checkOut(@Body() dto: CheckOutDto, @Req() req: any) {
    const data = await this.attendance.checkOut(this.caller(req), dto);
    return { success: true, message: 'Clocked out', data };
  }

  @Get('attendance/today')
  async today(@Req() req: any) {
    const data = await this.attendance.getTodayStatus(this.caller(req));
    return { success: true, data };
  }

  @Get('attendance/my')
  async my(@Query() q: StatsQueryDto, @Req() req: any) {
    const data = await this.attendance.getMyAttendance(
      this.caller(req),
      q.startDate,
      q.endDate,
    );
    return { success: true, data };
  }

  @Post('attendance/manual-entry')
  @HttpCode(HttpStatus.CREATED)
  async manualEntry(@Body() dto: ManualEntryDto, @Req() req: any) {
    const data = await this.attendance.createManualEntry(this.caller(req), dto);
    return { success: true, message: 'Manual entry submitted for approval', data };
  }

  @Put('attendance/:id/request-edit')
  async requestEdit(
    @Param('id') id: string,
    @Body() dto: RequestEditDto,
    @Req() req: any,
  ) {
    const data = await this.attendance.requestAttendanceEdit(this.caller(req), id, dto);
    return { success: true, message: 'Edit request submitted', data };
  }

  /**
   * Stats — a single endpoint that self-scopes for a plain employee and shows
   * org-wide numbers for a privileged caller (owner/admin/hr/manager or an
   * `attendance:view` permScoped role). No @RequirePermission: an employee is
   * NEVER blocked, just scoped to themselves.
   */
  @Get('attendance/stats')
  async stats(@Query() q: StatsQueryDto, @Req() req: any) {
    const c = this.caller(req);
    const scopeToSelf = !this.attendance.canViewOrgAttendance(c);
    const data = await this.attendance.getStats(c, q.startDate, q.endDate, scopeToSelf);
    return { success: true, data: { ...data, scope: scopeToSelf ? 'self' : 'org' } };
  }

  // ── org-wide (owner/admin or attendance:* permScoped) ───────────────────────

  @Get('attendance')
  @RequirePermission('attendance', 'view')
  async all(@Query() q: AttendanceQueryDto, @Req() req: any) {
    const data = await this.attendance.getAllAttendance(this.caller(req), q);
    return { success: true, data };
  }

  @Get('attendance/activity')
  @RequirePermission('attendance', 'view')
  async activity(
    @Query() q: AttendanceQueryDto & { view?: 'timeline' | 'grouped' | 'daily' },
    @Req() req: any,
  ) {
    const view = q.view === 'grouped' ? 'grouped' : q.view === 'daily' ? 'daily' : 'timeline';
    const data = await this.attendance.getActivityFeed(this.caller(req), {
      view,
      startDate: q.startDate,
      endDate: q.endDate,
      employeeId: q.employeeId,
    });
    return { success: true, ...data };
  }

  @Get('attendance/setup-status')
  @RequirePermission('attendance', 'view')
  async setupStatus(@Req() req: any) {
    const data = await this.attendance.getSetupStatus(this.caller(req));
    return { success: true, data };
  }

  @Get('attendance/pending-approvals')
  @RequirePermission('attendance', 'view')
  async pendingApprovals(@Req() req: any) {
    const data = await this.attendance.getPendingApprovals(this.caller(req));
    return { success: true, data };
  }

  @Put('attendance/:id/approve')
  @RequirePermission('attendance', 'edit')
  async approve(
    @Param('id') id: string,
    @Body() dto: ApproveEntryDto,
    @Req() req: any,
  ) {
    const data = await this.attendance.approveManualEntry(this.caller(req), id, dto);
    return { success: true, message: 'Entry reviewed', data };
  }

  @Put('attendance/:id/review-edit')
  @RequirePermission('attendance', 'edit')
  async reviewEdit(
    @Param('id') id: string,
    @Body() dto: ReviewEditDto,
    @Req() req: any,
  ) {
    const data = await this.attendance.reviewAttendanceEdit(this.caller(req), id, dto);
    return { success: true, message: 'Edit request reviewed', data };
  }

  // ── work-from-home requests ─────────────────────────────────────────────────
  // WFH is request → owner/HR approval → an approved day makes a normal clock-in
  // count as WFH (no geo-fence). Static routes are declared before `:id`.

  @Post('attendance/wfh-requests')
  @HttpCode(HttpStatus.CREATED)
  async requestWfh(@Body() dto: RequestWfhDto, @Req() req: any) {
    const c = this.caller(req);
    const data = await this.wfh.create(c.orgId, c.userId, dto);
    return { success: true, message: 'WFH request submitted for approval', data };
  }

  @Get('attendance/wfh-requests/mine')
  async myWfhRequests(@Req() req: any) {
    const c = this.caller(req);
    const data = await this.wfh.listMine(c.orgId, c.userId);
    return { success: true, data };
  }

  @Get('attendance/wfh-requests/pending')
  @RequirePermission('attendance', 'view')
  async pendingWfhRequests(@Req() req: any) {
    const data = await this.wfh.listPending(this.caller(req).orgId);
    return { success: true, data };
  }

  @Get('attendance/wfh-requests')
  @RequirePermission('attendance', 'view')
  async allWfhRequests(@Req() req: any) {
    const data = await this.wfh.listAll(this.caller(req).orgId);
    return { success: true, data };
  }

  @Post('attendance/wfh-requests/:id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelWfhRequest(@Param('id') id: string, @Req() req: any) {
    const c = this.caller(req);
    await this.wfh.cancel(c.orgId, id, c.userId);
    return { success: true, message: 'WFH request cancelled' };
  }

  @Put('attendance/wfh-requests/:id/review')
  @RequirePermission('attendance', 'edit')
  async reviewWfhRequest(
    @Param('id') id: string,
    @Body() dto: ReviewWfhDto,
    @Req() req: any,
  ) {
    const c = this.caller(req);
    const data = await this.wfh.review(c.orgId, id, dto.approved, c.userId, dto.note);
    return { success: true, message: 'WFH request reviewed', data };
  }

  // ── holidays ────────────────────────────────────────────────────────────────

  @Get('holidays')
  async listHolidays(@Query() q: HolidayQueryDto, @Req() req: any) {
    const data = await this.attendance.listHolidays(this.caller(req), q.year);
    return { success: true, data };
  }

  @Post('holidays')
  @RequirePermission('attendance', 'edit')
  @HttpCode(HttpStatus.CREATED)
  async createHoliday(@Body() dto: CreateHolidayDto, @Req() req: any) {
    const data = await this.attendance.createHoliday(this.caller(req), dto);
    return { success: true, message: 'Holiday added', data };
  }

  @Delete('holidays/:id')
  @RequirePermission('attendance', 'edit')
  async deleteHoliday(@Param('id') id: string, @Req() req: any) {
    await this.attendance.deleteHoliday(this.caller(req), id);
    return { success: true, message: 'Holiday removed' };
  }
}
