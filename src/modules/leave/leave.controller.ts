import {
  Body,
  Controller,
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
import { LeaveAccessGuard } from './guards/leave-access.guard';
import {
  RequirePermission,
  permMapAllows,
} from '../organization/guards/require-permission.decorator';
import { LeaveService } from './services/leave.service';
import { ApplyLeaveDto, CancelLeaveDto, RejectLeaveDto } from './dto';

/**
 * Leave surface (`/api/v1/leaves`). Guarded by JWT + LeaveAccessGuard: routes
 * WITHOUT `@RequirePermission` are self-service (any active member — apply, my
 * leaves, my balance, cancel own); routes WITH it are the manager surface
 * (owner/admin or a permScoped `leaves:*` role — org-wide list, approvals,
 * approve/reject, other members' balances).
 */
@Controller('leaves')
@UseGuards(JwtAuthGuard, LeaveAccessGuard)
export class LeaveController {
  constructor(private readonly leave: LeaveService) {}

  private orgId(req: any): string {
    const id = req.user?.organizationId;
    if (!id) throw new Error('No organization context');
    return id;
  }

  private canManage(req: any): boolean {
    const role = req.user?.orgRole;
    if (role === 'owner' || role === 'admin') return true;
    return permMapAllows(req.user?.perms, 'leaves', 'edit');
  }

  // ── catalog + self-service reads ──────────────────────────────────────────

  @Get('types')
  async types(@Req() req: any) {
    return { success: true, data: await this.leave.leaveTypes(this.orgId(req)) };
  }

  @Get('my')
  async my(@Query('status') status: string, @Req() req: any) {
    const data = await this.leave.myLeaves(this.orgId(req), req.user.userId, status || undefined);
    return { success: true, data };
  }

  @Get('balance')
  async balance(@Query('year') year: string, @Req() req: any) {
    const data = await this.leave.myBalance(
      this.orgId(req),
      req.user.userId,
      year ? Number(year) : undefined,
    );
    return { success: true, data };
  }

  @Get('stats')
  async stats(@Req() req: any) {
    const data = await this.leave.stats(this.orgId(req), req.user.userId);
    return { success: true, data };
  }

  // ── manager reads (declared before `:id`) ─────────────────────────────────

  @Get('pending')
  @RequirePermission('leaves', 'view')
  async pending(@Req() req: any) {
    const data = await this.leave.pendingApprovals(this.orgId(req));
    return { success: true, data };
  }

  @Get('balance/by-user/:userId')
  @RequirePermission('leaves', 'view')
  async balanceByUser(
    @Param('userId') userId: string,
    @Query('year') year: string,
    @Req() req: any,
  ) {
    const data = await this.leave.balanceForUser(
      this.orgId(req),
      userId,
      year ? Number(year) : undefined,
    );
    return { success: true, data };
  }

  @Get()
  @RequirePermission('leaves', 'view')
  async list(@Query('status') status: string, @Req() req: any) {
    const data = await this.leave.list(this.orgId(req), status || undefined);
    return { success: true, data };
  }

  // ── apply / decide / cancel ────────────────────────────────────────────────

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async apply(@Body() dto: ApplyLeaveDto, @Req() req: any) {
    const data = await this.leave.apply(
      this.orgId(req),
      req.user.userId,
      req.user.orgRole,
      dto,
    );
    return { success: true, message: 'Leave request submitted', data };
  }

  @Get(':id')
  async getOne(@Param('id') id: string, @Req() req: any) {
    const data = await this.leave.getOne(this.orgId(req), id, req.user.userId, this.canManage(req));
    return { success: true, data };
  }

  @Put(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('leaves', 'edit')
  async approve(@Param('id') id: string, @Req() req: any) {
    const data = await this.leave.approve(
      this.orgId(req),
      id,
      req.user.userId,
      req.user.orgRole,
    );
    return { success: true, message: 'Leave approved', data };
  }

  @Put(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('leaves', 'edit')
  async reject(@Param('id') id: string, @Body() dto: RejectLeaveDto, @Req() req: any) {
    const data = await this.leave.reject(
      this.orgId(req),
      id,
      req.user.userId,
      req.user.orgRole,
      dto.reason,
    );
    return { success: true, message: 'Leave declined', data };
  }

  @Put(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(@Param('id') id: string, @Body() dto: CancelLeaveDto, @Req() req: any) {
    const data = await this.leave.cancel(
      this.orgId(req),
      id,
      req.user.userId,
      this.canManage(req),
      dto.reason,
    );
    return { success: true, message: 'Leave cancelled', data };
  }
}
