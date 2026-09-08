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
import { AssessmentAccessGuard } from './guards/assessment-access.guard';
import { AssessmentService } from './assessment.service';
import {
  CreateAssessmentDto,
  RecordMarkDto,
  UpdateAssessmentDto,
} from './dto';

/**
 * Assessment / gradebook (`/api/v1/assessment`) — graded items on a class/section
 * and the per-student marks, on top of the lms roster and academic calendar.
 * Assessment/mark authoring is owner/admin only (AssessmentAccessGuard), always
 * scoped to the JWT's org. The two READ surfaces — class gradebook and student
 * report — use JwtAuthGuard only and are authorized inside AssessmentService to
 * owner/admin OR the class's assigned teacher, exactly like the lms roster.
 */
@Controller('assessment')
export class AssessmentController {
  constructor(private readonly assessment: AssessmentService) {}

  private orgId(req: any): string {
    const id = req.user?.organizationId;
    if (!id) throw new Error('No organization context');
    return id;
  }

  // ── assessments ─────────────────────────────────────────────────────────────

  @Post('classes/:classId/assessments')
  @UseGuards(JwtAuthGuard, AssessmentAccessGuard)
  @HttpCode(HttpStatus.CREATED)
  async createAssessment(
    @Param('classId') classId: string,
    @Body() dto: CreateAssessmentDto,
    @Req() req: any,
  ) {
    const data = await this.assessment.createAssessment(
      this.orgId(req),
      classId,
      dto,
      req.user.userId,
    );
    return { success: true, data };
  }

  @Get('classes/:classId/assessments')
  @UseGuards(JwtAuthGuard, AssessmentAccessGuard)
  async listAssessments(@Param('classId') classId: string, @Req() req: any) {
    const data = await this.assessment.listAssessments(this.orgId(req), classId);
    return { success: true, data };
  }

  @Get('assessments/:assessmentId')
  @UseGuards(JwtAuthGuard, AssessmentAccessGuard)
  async getAssessment(
    @Param('assessmentId') assessmentId: string,
    @Req() req: any,
  ) {
    const data = await this.assessment.getAssessment(
      this.orgId(req),
      assessmentId,
    );
    return { success: true, data };
  }

  @Put('assessments/:assessmentId')
  @UseGuards(JwtAuthGuard, AssessmentAccessGuard)
  async updateAssessment(
    @Param('assessmentId') assessmentId: string,
    @Body() dto: UpdateAssessmentDto,
    @Req() req: any,
  ) {
    const data = await this.assessment.updateAssessment(
      this.orgId(req),
      assessmentId,
      dto,
      req.user.userId,
    );
    return { success: true, data };
  }

  @Delete('assessments/:assessmentId')
  @UseGuards(JwtAuthGuard, AssessmentAccessGuard)
  async removeAssessment(
    @Param('assessmentId') assessmentId: string,
    @Req() req: any,
  ) {
    await this.assessment.removeAssessment(this.orgId(req), assessmentId);
    return { success: true, message: 'Assessment removed' };
  }

  // ── marks ─────────────────────────────────────────────────────────────────────

  @Post('assessments/:assessmentId/marks')
  @UseGuards(JwtAuthGuard, AssessmentAccessGuard)
  @HttpCode(HttpStatus.CREATED)
  async recordMark(
    @Param('assessmentId') assessmentId: string,
    @Body() dto: RecordMarkDto,
    @Req() req: any,
  ) {
    const data = await this.assessment.recordMark(
      this.orgId(req),
      assessmentId,
      dto,
      req.user.userId,
    );
    return { success: true, data };
  }

  // ── reads: gradebook + student report (owner/admin OR class teacher) ────────────

  @Get('classes/:classId/gradebook')
  @UseGuards(JwtAuthGuard)
  async gradebook(@Param('classId') classId: string, @Req() req: any) {
    const data = await this.assessment.gradebook(this.orgId(req), classId, {
      userId: req.user.userId,
      orgRole: req.user.orgRole,
    });
    return { success: true, data };
  }

  @Get('enrolments/:enrolmentId/report')
  @UseGuards(JwtAuthGuard)
  async studentReport(
    @Param('enrolmentId') enrolmentId: string,
    @Req() req: any,
  ) {
    const data = await this.assessment.studentReport(
      this.orgId(req),
      enrolmentId,
      { userId: req.user.userId, orgRole: req.user.orgRole },
    );
    return { success: true, data };
  }
}
