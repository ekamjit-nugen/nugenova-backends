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
import { RequirePermission } from '../organization/guards/require-permission.decorator';
import { TaxDeclarationService } from './services/tax-declaration.service';
import { SaveTaxDeclarationDto, ReviewTaxDeclarationDto } from './dto';

/**
 * Investment-declaration surface (`/api/v1/payroll/tax-declarations`). Same guard
 * pattern as payroll: undecorated `/me*` routes are self-service (any member
 * declares their own investments); `@RequirePermission('payroll',…)` routes are
 * the review queue for payroll/HR.
 */
@Controller('payroll/tax-declarations')
@UseGuards(JwtAuthGuard, PayrollAccessGuard)
export class TaxDeclarationController {
  constructor(private readonly service: TaxDeclarationService) {}

  private orgId(req: any): string {
    const id = req.user?.organizationId;
    if (!id) throw new Error('No organization context');
    return id;
  }

  /** FY start year from `?fy=2025`, defaulting to the current financial year. */
  private fyStart(fy?: string): number {
    const n = Number(fy);
    if (n >= 2000 && n <= 2100) return Math.floor(n);
    return this.service.fyStartYearOf(new Date());
  }

  // ── self-service ────────────────────────────────────────────────────────────

  @Get('me')
  async getMine(@Query('fy') fy: string, @Req() req: any) {
    const data = await this.service.getMine(this.orgId(req), req.user.userId, this.fyStart(fy));
    return { success: true, data };
  }

  @Put('me')
  async saveMine(@Query('fy') fy: string, @Body() dto: SaveTaxDeclarationDto, @Req() req: any) {
    const data = await this.service.saveMine(this.orgId(req), req.user.userId, this.fyStart(fy), dto);
    return { success: true, message: 'Declaration saved', data };
  }

  @Post('me/submit')
  @HttpCode(HttpStatus.OK)
  async submitMine(@Query('fy') fy: string, @Req() req: any) {
    const data = await this.service.submitMine(this.orgId(req), req.user.userId, this.fyStart(fy));
    return { success: true, message: 'Declaration submitted for review', data };
  }

  // ── payroll/HR: enter declarations on behalf of employees ────────────────────

  @Get()
  @RequirePermission('payroll', 'view')
  async listForReview(@Query('status') status: string, @Query('fy') fy: string, @Req() req: any) {
    const data = await this.service.listForReview(this.orgId(req), {
      status: status || undefined,
      fyStart: fy ? this.fyStart(fy) : undefined,
    });
    return { success: true, data };
  }

  /** An employee's declaration for a FY (for HR to view/edit). */
  @Get('employee/:userId')
  @RequirePermission('payroll', 'view')
  async getForEmployee(@Param('userId') userId: string, @Query('fy') fy: string, @Req() req: any) {
    const data = await this.service.getMine(this.orgId(req), userId, this.fyStart(fy));
    return { success: true, data };
  }

  /** HR records/updates an employee's declaration (saved as verified — drives TDS). */
  @Put('employee/:userId')
  @RequirePermission('payroll', 'edit')
  async setForEmployee(
    @Param('userId') userId: string,
    @Query('fy') fy: string,
    @Body() dto: SaveTaxDeclarationDto,
    @Req() req: any,
  ) {
    const data = await this.service.setForEmployee(this.orgId(req), userId, this.fyStart(fy), dto, req.user.userId);
    return { success: true, message: 'Declaration saved', data };
  }

  @Post(':id/review')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('payroll', 'edit')
  async review(@Param('id') id: string, @Body() dto: ReviewTaxDeclarationDto, @Req() req: any) {
    const data = await this.service.review(
      this.orgId(req),
      id,
      { userId: req.user.userId, role: req.user.orgRole },
      dto,
    );
    return { success: true, message: `Declaration ${dto.action === 'verify' ? 'verified' : 'rejected'}`, data };
  }
}
