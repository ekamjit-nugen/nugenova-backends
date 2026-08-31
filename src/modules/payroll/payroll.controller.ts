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
import { PayrollAccessGuard } from './guards/payroll-access.guard';
import {
  RequirePermission,
  permMapAllows,
} from '../organization/guards/require-permission.decorator';
import { PayrollService } from './services/payroll.service';
import { SetSalaryDto, GeneratePayslipsDto } from './dto';

/**
 * Payroll surface (`/api/v1/payroll`). JWT + PayrollAccessGuard. Undecorated
 * routes are self-service (my salary, my payslips); `@RequirePermission('payroll',…)`
 * routes are the manager surface (salary editing, running payslips, org-wide reads).
 */
@Controller('payroll')
@UseGuards(JwtAuthGuard, PayrollAccessGuard)
export class PayrollController {
  constructor(private readonly payroll: PayrollService) {}

  private orgId(req: any): string {
    const id = req.user?.organizationId;
    if (!id) throw new Error('No organization context');
    return id;
  }

  private canManage(req: any): boolean {
    const role = req.user?.orgRole;
    if (role === 'owner' || role === 'admin') return true;
    return permMapAllows(req.user?.perms, 'payroll', 'edit');
  }

  // ── self-service ────────────────────────────────────────────────────────────

  @Get('salary/me')
  async mySalary(@Req() req: any) {
    const data = await this.payroll.getSalary(this.orgId(req), req.user.userId);
    return { success: true, data };
  }

  @Get('payslips/my')
  async myPayslips(@Query('year') year: string, @Req() req: any) {
    const data = await this.payroll.myPayslips(
      this.orgId(req),
      req.user.userId,
      year ? Number(year) : undefined,
    );
    return { success: true, data };
  }

  // ── manager surface (declared before `:id` params) ──────────────────────────

  @Get('salaries')
  @RequirePermission('payroll', 'view')
  async listSalaries(@Req() req: any) {
    const data = await this.payroll.listSalaries(this.orgId(req));
    return { success: true, data };
  }

  @Get('salary/:userId')
  @RequirePermission('payroll', 'view')
  async getSalary(@Param('userId') userId: string, @Req() req: any) {
    const data = await this.payroll.getSalary(this.orgId(req), userId);
    return { success: true, data };
  }

  @Put('salary/:userId')
  @RequirePermission('payroll', 'edit')
  async setSalary(@Param('userId') userId: string, @Body() dto: SetSalaryDto, @Req() req: any) {
    const data = await this.payroll.setSalary(this.orgId(req), userId, dto, req.user.userId);
    return { success: true, message: 'Salary saved', data };
  }

  @Post('payslips/generate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('payroll', 'edit')
  async generate(@Body() dto: GeneratePayslipsDto, @Req() req: any) {
    const data = await this.payroll.generatePayslips(this.orgId(req), dto, req.user.userId);
    return { success: true, message: `Generated ${data.generated} payslip(s)`, data };
  }

  @Get('payslips')
  @RequirePermission('payroll', 'view')
  async listPayslips(
    @Query('month') month: string,
    @Query('year') year: string,
    @Req() req: any,
  ) {
    const data = await this.payroll.listPayslips(
      this.orgId(req),
      month ? Number(month) : undefined,
      year ? Number(year) : undefined,
    );
    return { success: true, data };
  }

  @Get('payslips/:id')
  async getPayslip(@Param('id') id: string, @Req() req: any) {
    const data = await this.payroll.getPayslip(
      this.orgId(req),
      id,
      req.user.userId,
      this.canManage(req),
    );
    return { success: true, data };
  }
}
