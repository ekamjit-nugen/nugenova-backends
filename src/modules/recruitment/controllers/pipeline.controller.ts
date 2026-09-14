import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RequirePermission } from '../../organization/guards/require-permission.decorator';
import { RecruitmentAccessGuard } from '../guards/recruitment-access.guard';
import { OpeningsService } from '../services/openings.service';
import { PipelineService } from '../services/pipeline.service';
import { RecruitmentAnalyticsService } from '../services/analytics.service';
import { callerFromRequest } from '../services/recruitment-caller';
import {
  BulkMoveDto, CreateApplicationDto, CreateOpeningDto, CreateStageDto, MoveApplicationDto, ReorderStagesDto,
  ScorecardTemplateDto, UpdateApplicationDto, UpdateOpeningDto, UpdateSettingsDto, UpdateStageDto,
} from '../dto';

const R = 'recruitment';

/** `/api/v1/recruitment/*` — openings, the pipeline board, applications, settings, analytics. */
@Controller('recruitment')
@UseGuards(JwtAuthGuard, RecruitmentAccessGuard)
export class PipelineController {
  constructor(
    private readonly openings: OpeningsService,
    private readonly pipeline: PipelineService,
    private readonly analytics: RecruitmentAnalyticsService,
  ) {}

  private ok<T>(data: T) { return { success: true, data }; }

  // ── analytics ──
  @Get('analytics')
  @RequirePermission(R, 'view')
  async overview(@Req() req: any, @Query('openingId') openingId?: string, @Query('days') days?: string) {
    return this.ok(await this.analytics.overview(callerFromRequest(req), { openingId, days }));
  }

  @Get('people')
  @RequirePermission(R, 'view')
  async people(@Req() req: any) {
    return this.ok(await this.pipeline.listPeople(callerFromRequest(req).orgId));
  }

  // ── settings (stages, reasons, scorecards) ──
  @Get('stages')
  async stages(@Req() req: any) {
    return this.ok(await this.pipeline.ensureStages(callerFromRequest(req).orgId));
  }

  @Post('stages')
  @RequirePermission(R, 'edit')
  async createStage(@Req() req: any, @Body() dto: CreateStageDto) {
    return this.ok(await this.pipeline.createStage(callerFromRequest(req), dto));
  }

  @Put('stages/order')
  @RequirePermission(R, 'edit')
  async reorderStages(@Req() req: any, @Body() dto: ReorderStagesDto) {
    return this.ok(await this.pipeline.reorderStages(callerFromRequest(req), dto));
  }

  @Patch('stages/:id')
  @RequirePermission(R, 'edit')
  async updateStage(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateStageDto) {
    return this.ok(await this.pipeline.updateStage(callerFromRequest(req), id, dto));
  }

  @Delete('stages/:id')
  @RequirePermission(R, 'edit')
  async deleteStage(@Req() req: any, @Param('id') id: string) {
    return this.ok(await this.pipeline.deleteStage(callerFromRequest(req), id));
  }

  @Get('settings')
  @RequirePermission(R, 'view')
  async settings(@Req() req: any) {
    return this.ok(await this.pipeline.getSettings(callerFromRequest(req).orgId));
  }

  @Patch('settings')
  @RequirePermission(R, 'edit')
  async updateSettings(@Req() req: any, @Body() dto: UpdateSettingsDto) {
    return this.ok(await this.pipeline.updateSettings(callerFromRequest(req), dto));
  }

  @Get('scorecards')
  async scorecards(@Req() req: any) {
    return this.ok(await this.pipeline.listScorecards(callerFromRequest(req).orgId));
  }

  @Post('scorecards')
  @RequirePermission(R, 'edit')
  async createScorecard(@Req() req: any, @Body() dto: ScorecardTemplateDto) {
    return this.ok(await this.pipeline.saveScorecard(callerFromRequest(req), dto));
  }

  @Put('scorecards/:id')
  @RequirePermission(R, 'edit')
  async updateScorecard(@Req() req: any, @Param('id') id: string, @Body() dto: ScorecardTemplateDto) {
    return this.ok(await this.pipeline.saveScorecard(callerFromRequest(req), dto, id));
  }

  @Delete('scorecards/:id')
  @RequirePermission(R, 'edit')
  async deleteScorecard(@Req() req: any, @Param('id') id: string) {
    return this.ok(await this.pipeline.deleteScorecard(callerFromRequest(req), id));
  }

  // ── openings ──
  @Get('openings')
  @RequirePermission(R, 'view')
  async listOpenings(@Req() req: any, @Query('status') status?: string, @Query('q') q?: string) {
    return this.ok(await this.openings.list(callerFromRequest(req), { status, q }));
  }

  @Post('openings')
  @RequirePermission(R, 'create')
  async createOpening(@Req() req: any, @Body() dto: CreateOpeningDto) {
    return this.ok(await this.openings.create(callerFromRequest(req), dto));
  }

  @Get('openings/:id')
  @RequirePermission(R, 'view')
  async getOpening(@Req() req: any, @Param('id') id: string) {
    return this.ok(await this.openings.get(callerFromRequest(req), id));
  }

  @Get('openings/:id/board')
  @RequirePermission(R, 'view')
  async board(@Req() req: any, @Param('id') id: string) {
    return this.ok(await this.openings.board(callerFromRequest(req), id));
  }

  @Patch('openings/:id')
  @RequirePermission(R, 'edit')
  async updateOpening(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateOpeningDto) {
    return this.ok(await this.openings.update(callerFromRequest(req), id, dto));
  }

  @Delete('openings/:id')
  @RequirePermission(R, 'delete')
  async deleteOpening(@Req() req: any, @Param('id') id: string) {
    return this.ok(await this.openings.remove(callerFromRequest(req), id));
  }

  // ── applications ──
  @Post('applications')
  @RequirePermission(R, 'edit')
  async createApplication(@Req() req: any, @Body() dto: CreateApplicationDto) {
    return this.ok(await this.pipeline.createApplication(callerFromRequest(req), dto));
  }

  @Post('applications/bulk-move')
  @RequirePermission(R, 'edit')
  async bulkMove(@Req() req: any, @Body() dto: BulkMoveDto) {
    return this.ok(await this.pipeline.bulkMove(callerFromRequest(req), dto));
  }

  @Patch('applications/:id/move')
  @RequirePermission(R, 'edit')
  async move(@Req() req: any, @Param('id') id: string, @Body() dto: MoveApplicationDto) {
    return this.ok(await this.pipeline.moveApplication(callerFromRequest(req), id, dto));
  }

  @Patch('applications/:id')
  @RequirePermission(R, 'edit')
  async updateApplication(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateApplicationDto) {
    return this.ok(await this.pipeline.updateApplication(callerFromRequest(req), id, dto));
  }

  @Delete('applications/:id')
  @RequirePermission(R, 'delete')
  async deleteApplication(@Req() req: any, @Param('id') id: string) {
    return this.ok(await this.pipeline.deleteApplication(callerFromRequest(req), id));
  }
}
