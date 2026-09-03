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
  Req,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AcademicAccessGuard } from './guards/academic-access.guard';
import { AcademicService } from './academic.service';
import {
  CreateAcademicYearDto,
  CreateTermDto,
  UpdateAcademicYearDto,
  UpdateTermDto,
} from './dto';

/**
 * Academic calendar (`/api/v1/academic`). Owner/admin only (AcademicAccessGuard),
 * always scoped to the JWT's org. Years hold ordered terms; exactly one year per
 * org is `current`. This is the foundation the future gradebook/enrolment anchors
 * to — no student-facing surface here.
 */
@Controller('academic')
@UseGuards(JwtAuthGuard, AcademicAccessGuard)
export class AcademicController {
  constructor(private readonly academic: AcademicService) {}

  private orgId(req: any): string {
    const id = req.user?.organizationId;
    if (!id) throw new Error('No organization context');
    return id;
  }

  // ── academic years ──────────────────────────────────────────────────────────

  @Post('years')
  @HttpCode(HttpStatus.CREATED)
  async createYear(@Body() dto: CreateAcademicYearDto, @Req() req: any) {
    const data = await this.academic.createYear(this.orgId(req), dto, req.user.userId);
    return { success: true, data };
  }

  @Get('years')
  async listYears(@Req() req: any) {
    const data = await this.academic.listYears(this.orgId(req));
    return { success: true, data };
  }

  /** The org's single current academic year (declared before `:yearId`). */
  @Get('years/current')
  async currentYear(@Req() req: any) {
    const data = await this.academic.getCurrentYear(this.orgId(req));
    return { success: true, data };
  }

  @Get('years/:yearId')
  async getYear(@Param('yearId') yearId: string, @Req() req: any) {
    const data = await this.academic.getYear(this.orgId(req), yearId);
    return { success: true, data };
  }

  @Put('years/:yearId')
  async updateYear(
    @Param('yearId') yearId: string,
    @Body() dto: UpdateAcademicYearDto,
    @Req() req: any,
  ) {
    const data = await this.academic.updateYear(
      this.orgId(req),
      yearId,
      dto,
      req.user.userId,
    );
    return { success: true, data };
  }

  /** Make this year the org's current one. */
  @Put('years/:yearId/current')
  async setCurrent(@Param('yearId') yearId: string, @Req() req: any) {
    const data = await this.academic.setCurrentYear(
      this.orgId(req),
      yearId,
      req.user.userId,
    );
    return { success: true, data };
  }

  @Delete('years/:yearId')
  async removeYear(@Param('yearId') yearId: string, @Req() req: any) {
    await this.academic.removeYear(this.orgId(req), yearId);
    return { success: true, message: 'Academic year removed' };
  }

  // ── terms ───────────────────────────────────────────────────────────────────

  @Post('years/:yearId/terms')
  @HttpCode(HttpStatus.CREATED)
  async createTerm(
    @Param('yearId') yearId: string,
    @Body() dto: CreateTermDto,
    @Req() req: any,
  ) {
    const data = await this.academic.createTerm(
      this.orgId(req),
      yearId,
      dto,
      req.user.userId,
    );
    return { success: true, data };
  }

  @Get('years/:yearId/terms')
  async listTerms(@Param('yearId') yearId: string, @Req() req: any) {
    const data = await this.academic.listTerms(this.orgId(req), yearId);
    return { success: true, data };
  }

  @Put('years/:yearId/terms/:termId')
  async updateTerm(
    @Param('yearId') yearId: string,
    @Param('termId') termId: string,
    @Body() dto: UpdateTermDto,
    @Req() req: any,
  ) {
    const data = await this.academic.updateTerm(
      this.orgId(req),
      yearId,
      termId,
      dto,
      req.user.userId,
    );
    return { success: true, data };
  }

  @Delete('years/:yearId/terms/:termId')
  async removeTerm(
    @Param('yearId') yearId: string,
    @Param('termId') termId: string,
    @Req() req: any,
  ) {
    await this.academic.removeTerm(this.orgId(req), yearId, termId);
    return { success: true, message: 'Term removed' };
  }
}
