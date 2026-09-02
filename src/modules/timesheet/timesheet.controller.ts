import {
  Body,
  Controller,
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
import { AttendanceAccessGuard } from '../attendance/guards/attendance-access.guard';
import { RequirePermission } from '../organization/guards/require-permission.decorator';
import { TimesheetService } from './timesheet.service';
import { SaveTimesheetDto, ReviewTimesheetDto } from './dto';

/**
 * Timesheets (`/api/v1/timesheets`). Same guard model as attendance: undecorated
 * `/me*` routes are self-service (any member logs & submits their own time);
 * `@RequirePermission('attendance', …)` routes are the manager review queue.
 */
@Controller('timesheets')
@UseGuards(JwtAuthGuard, AttendanceAccessGuard)
export class TimesheetController {
  constructor(private readonly service: TimesheetService) {}

  private orgId(req: any): string {
    const id = req.user?.organizationId;
    if (!id) throw new Error('No organization context');
    return id;
  }

  /** The owner is the employer — they approve timesheets, they don't file them. */
  private assertNotOwner(req: any): void {
    if ((req.user?.orgRole || '').toLowerCase() === 'owner') {
      throw new ForbiddenException('Owners approve timesheets — they don’t submit their own.');
    }
  }

  // ── self-service ────────────────────────────────────────────────────────────

  @Get('me')
  async myTimesheet(@Query('ref') ref: string, @Req() req: any) {
    const data = await this.service.myTimesheet(this.orgId(req), req.user.userId, ref || undefined);
    return { success: true, data };
  }

  @Put('me')
  async saveMine(@Query('ref') ref: string, @Body() dto: SaveTimesheetDto, @Req() req: any) {
    this.assertNotOwner(req);
    const data = await this.service.saveMine(this.orgId(req), req.user.userId, ref || undefined, dto);
    return { success: true, message: 'Timesheet saved', data };
  }

  @Post('me/submit')
  @HttpCode(HttpStatus.OK)
  async submitMine(@Query('ref') ref: string, @Body() dto: SaveTimesheetDto, @Req() req: any) {
    this.assertNotOwner(req);
    const data = await this.service.submitMine(this.orgId(req), req.user.userId, ref || undefined, dto);
    return { success: true, message: 'Timesheet submitted for approval', data };
  }

  // ── manager review queue ─────────────────────────────────────────────────────

  @Get()
  @RequirePermission('attendance', 'view')
  async listForReview(
    @Query('status') status: string,
    @Query('year') year: string,
    @Query('month') month: string,
    @Query('userId') userId: string,
    @Req() req: any,
  ) {
    const data = await this.service.listForReview(this.orgId(req), {
      status: status || undefined,
      year: year ? Number(year) : undefined,
      month: month ? Number(month) : undefined,
      userId: userId || undefined,
    });
    return { success: true, data };
  }

  @Get(':id')
  @RequirePermission('attendance', 'view')
  async detailForReview(@Param('id') id: string, @Req() req: any) {
    const data = await this.service.detailForReview(this.orgId(req), id);
    return { success: true, data };
  }

  @Post(':id/review')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('attendance', 'edit')
  async review(@Param('id') id: string, @Body() dto: ReviewTimesheetDto, @Req() req: any) {
    const data = await this.service.review(
      this.orgId(req),
      id,
      { userId: req.user.userId, role: req.user.orgRole },
      dto,
    );
    return { success: true, message: `Timesheet ${dto.action === 'approve' ? 'approved' : 'rejected'}`, data };
  }
}
