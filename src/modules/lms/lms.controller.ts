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
import { LmsAccessGuard } from './guards/lms-access.guard';
import { LmsService } from './lms.service';
import {
  CreateClassDto,
  CreateCourseDto,
  EnrolStudentDto,
  UpdateClassDto,
  UpdateCourseDto,
} from './dto';

/**
 * LMS (`/api/v1/lms`) — courses, class/sections and enrolment, on top of the
 * academic calendar. Course/class/enrolment authoring is owner/admin only
 * (LmsAccessGuard), always scoped to the JWT's org. The student roster is the
 * one non-admin surface: it uses JwtAuthGuard only, and LmsService authorizes it
 * to owner/admin OR the class's assigned teacher — a teacher-facing read that is
 * NOT the staff directory and never lists staff.
 */
@Controller('lms')
export class LmsController {
  constructor(private readonly lms: LmsService) {}

  private orgId(req: any): string {
    const id = req.user?.organizationId;
    if (!id) throw new Error('No organization context');
    return id;
  }

  // ── courses ─────────────────────────────────────────────────────────────────

  @Post('courses')
  @UseGuards(JwtAuthGuard, LmsAccessGuard)
  @HttpCode(HttpStatus.CREATED)
  async createCourse(@Body() dto: CreateCourseDto, @Req() req: any) {
    const data = await this.lms.createCourse(this.orgId(req), dto, req.user.userId);
    return { success: true, data };
  }

  @Get('courses')
  @UseGuards(JwtAuthGuard, LmsAccessGuard)
  async listCourses(@Req() req: any) {
    const data = await this.lms.listCourses(this.orgId(req));
    return { success: true, data };
  }

  @Get('courses/:courseId')
  @UseGuards(JwtAuthGuard, LmsAccessGuard)
  async getCourse(@Param('courseId') courseId: string, @Req() req: any) {
    const data = await this.lms.getCourse(this.orgId(req), courseId);
    return { success: true, data };
  }

  @Put('courses/:courseId')
  @UseGuards(JwtAuthGuard, LmsAccessGuard)
  async updateCourse(
    @Param('courseId') courseId: string,
    @Body() dto: UpdateCourseDto,
    @Req() req: any,
  ) {
    const data = await this.lms.updateCourse(
      this.orgId(req),
      courseId,
      dto,
      req.user.userId,
    );
    return { success: true, data };
  }

  @Delete('courses/:courseId')
  @UseGuards(JwtAuthGuard, LmsAccessGuard)
  async removeCourse(@Param('courseId') courseId: string, @Req() req: any) {
    await this.lms.removeCourse(this.orgId(req), courseId);
    return { success: true, message: 'Course removed' };
  }

  // ── classes / sections ────────────────────────────────────────────────────────

  @Post('classes')
  @UseGuards(JwtAuthGuard, LmsAccessGuard)
  @HttpCode(HttpStatus.CREATED)
  async createClass(@Body() dto: CreateClassDto, @Req() req: any) {
    const data = await this.lms.createClass(this.orgId(req), dto, req.user.userId);
    return { success: true, data };
  }

  @Get('classes')
  @UseGuards(JwtAuthGuard, LmsAccessGuard)
  async listClasses(
    @Req() req: any,
    @Query('courseId') courseId?: string,
    @Query('termId') termId?: string,
  ) {
    const data = await this.lms.listClasses(this.orgId(req), { courseId, termId });
    return { success: true, data };
  }

  @Get('classes/:classId')
  @UseGuards(JwtAuthGuard, LmsAccessGuard)
  async getClass(@Param('classId') classId: string, @Req() req: any) {
    const data = await this.lms.getClass(this.orgId(req), classId);
    return { success: true, data };
  }

  @Put('classes/:classId')
  @UseGuards(JwtAuthGuard, LmsAccessGuard)
  async updateClass(
    @Param('classId') classId: string,
    @Body() dto: UpdateClassDto,
    @Req() req: any,
  ) {
    const data = await this.lms.updateClass(
      this.orgId(req),
      classId,
      dto,
      req.user.userId,
    );
    return { success: true, data };
  }

  @Delete('classes/:classId')
  @UseGuards(JwtAuthGuard, LmsAccessGuard)
  async removeClass(@Param('classId') classId: string, @Req() req: any) {
    await this.lms.removeClass(this.orgId(req), classId);
    return { success: true, message: 'Class removed' };
  }

  /**
   * Student roster for a class — owner/admin OR the assigned teacher (authorized
   * in the service). JwtAuthGuard only, deliberately NOT LmsAccessGuard.
   */
  @Get('classes/:classId/roster')
  @UseGuards(JwtAuthGuard)
  async roster(@Param('classId') classId: string, @Req() req: any) {
    const data = await this.lms.roster(this.orgId(req), classId, {
      userId: req.user.userId,
      orgRole: req.user.orgRole,
    });
    return { success: true, data };
  }

  // ── enrolments ────────────────────────────────────────────────────────────────

  @Post('classes/:classId/enrolments')
  @UseGuards(JwtAuthGuard, LmsAccessGuard)
  @HttpCode(HttpStatus.CREATED)
  async enrol(
    @Param('classId') classId: string,
    @Body() dto: EnrolStudentDto,
    @Req() req: any,
  ) {
    const data = await this.lms.enrol(
      this.orgId(req),
      classId,
      dto,
      req.user.userId,
    );
    return { success: true, data };
  }

  @Get('classes/:classId/enrolments')
  @UseGuards(JwtAuthGuard, LmsAccessGuard)
  async listEnrolments(@Param('classId') classId: string, @Req() req: any) {
    const data = await this.lms.listEnrolments(this.orgId(req), classId);
    return { success: true, data };
  }

  @Put('classes/:classId/enrolments/:enrolmentId/withdraw')
  @UseGuards(JwtAuthGuard, LmsAccessGuard)
  async withdraw(
    @Param('classId') classId: string,
    @Param('enrolmentId') enrolmentId: string,
    @Req() req: any,
  ) {
    const data = await this.lms.withdraw(
      this.orgId(req),
      classId,
      enrolmentId,
      req.user.userId,
    );
    return { success: true, data };
  }

  @Put('classes/:classId/enrolments/:enrolmentId/complete')
  @UseGuards(JwtAuthGuard, LmsAccessGuard)
  async complete(
    @Param('classId') classId: string,
    @Param('enrolmentId') enrolmentId: string,
    @Req() req: any,
  ) {
    const data = await this.lms.complete(
      this.orgId(req),
      classId,
      enrolmentId,
      req.user.userId,
    );
    return { success: true, data };
  }
}
