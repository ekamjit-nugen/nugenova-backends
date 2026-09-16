import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RequirePermission } from '../../organization/guards/require-permission.decorator';
import { RecruitmentAccessGuard } from '../guards/recruitment-access.guard';
import { LeadWorkspaceService } from '../services/lead-workspace.service';
import { MatchingService } from '../services/matching.service';
import { SubmissionsService } from '../services/submissions.service';
import { callerFromRequest } from '../services/recruitment-caller';
import {
  BulkSubmissionDto, CreateSubmissionDto, LeadDocumentDto, LeadFollowupDto, LeadNoteDto, LeadRequirementDto, MoveSubmissionDto,
  UpdateLeadFollowupDto, UpdateLeadWorkspaceDto, UpdateSubmissionDto,
} from '../dto';

const R = 'recruitment';

/**
 * `/api/v1/recruitment/leads`, `/submissions`, `/matches` — Sales leads managed from
 * the Recruitment panel, candidates submitted against their requirements, and
 * talent-pool matching. All gated on the `recruitment` permission.
 */
@Controller('recruitment')
@UseGuards(JwtAuthGuard, RecruitmentAccessGuard)
export class LeadsController {
  constructor(
    private readonly workspace: LeadWorkspaceService,
    private readonly submissions: SubmissionsService,
    private readonly matching: MatchingService,
  ) {}

  private ok<T>(data: T) { return { success: true, data }; }

  // ── matching ──
  @Get('matches')
  @RequirePermission(R, 'view')
  async matches(@Req() req: any, @Query('openingId') openingId?: string, @Query('requirementId') requirementId?: string, @Query('limit') limit?: string) {
    return this.ok(await this.matching.matchesFor(callerFromRequest(req), { openingId, requirementId, limit }));
  }

  // ── leads ──
  @Get('leads')
  @RequirePermission(R, 'view')
  async list(
    @Req() req: any, @Query('status') status?: string, @Query('q') q?: string, @Query('ownerId') ownerId?: string,
    @Query('stageId') stageId?: string, @Query('hasOpenRequirements') hasOpenRequirements?: string,
  ) {
    return this.ok(await this.workspace.list(callerFromRequest(req), { status, q, ownerId, stageId, hasOpenRequirements }));
  }

  @Get('leads/:id')
  @RequirePermission(R, 'view')
  async get(@Req() req: any, @Param('id') id: string) {
    return this.ok(await this.workspace.get(callerFromRequest(req), id));
  }

  @Patch('leads/:id')
  @RequirePermission(R, 'edit')
  async update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateLeadWorkspaceDto) {
    return this.ok(await this.workspace.update(callerFromRequest(req), id, dto));
  }

  @Post('leads/:id/move')
  @RequirePermission(R, 'edit')
  async move(@Req() req: any, @Param('id') id: string, @Body('stageId') stageId: string) {
    return this.ok(await this.workspace.move(callerFromRequest(req), id, stageId));
  }

  @Post('leads/:id/requirements')
  @RequirePermission(R, 'edit')
  async addRequirement(@Req() req: any, @Param('id') id: string, @Body() dto: LeadRequirementDto) {
    return this.ok(await this.workspace.addRequirement(callerFromRequest(req), id, dto));
  }

  @Patch('leads/:id/requirements/:reqId')
  @RequirePermission(R, 'edit')
  async updateRequirement(@Req() req: any, @Param('id') id: string, @Param('reqId') reqId: string, @Body() dto: LeadRequirementDto) {
    return this.ok(await this.workspace.updateRequirement(callerFromRequest(req), id, reqId, dto));
  }

  @Delete('leads/:id/requirements/:reqId')
  @RequirePermission(R, 'edit')
  async deleteRequirement(@Req() req: any, @Param('id') id: string, @Param('reqId') reqId: string) {
    return this.ok(await this.workspace.deleteRequirement(callerFromRequest(req), id, reqId));
  }

  @Post('leads/:id/requirements/:reqId/opening')
  @RequirePermission(R, 'create')
  async openingFromRequirement(@Req() req: any, @Param('id') id: string, @Param('reqId') reqId: string) {
    return this.ok(await this.workspace.openingFromRequirement(callerFromRequest(req), id, reqId));
  }

  @Post('leads/:id/followups')
  @RequirePermission(R, 'edit')
  async addFollowup(@Req() req: any, @Param('id') id: string, @Body() dto: LeadFollowupDto) {
    return this.ok(await this.workspace.addFollowup(callerFromRequest(req), id, dto));
  }

  @Patch('leads/:id/followups/:followupId')
  @RequirePermission(R, 'edit')
  async updateFollowup(@Req() req: any, @Param('id') id: string, @Param('followupId') followupId: string, @Body() dto: UpdateLeadFollowupDto) {
    return this.ok(await this.workspace.updateFollowup(callerFromRequest(req), id, followupId, dto));
  }

  @Post('leads/:id/notes')
  @RequirePermission(R, 'edit')
  async addNote(@Req() req: any, @Param('id') id: string, @Body() dto: LeadNoteDto) {
    return this.ok(await this.workspace.addNote(callerFromRequest(req), id, dto));
  }

  @Post('leads/:id/documents')
  @RequirePermission(R, 'edit')
  async addDocument(@Req() req: any, @Param('id') id: string, @Body() dto: LeadDocumentDto) {
    return this.ok(await this.workspace.addDocument(callerFromRequest(req), id, dto));
  }

  @Delete('leads/:id/documents/:docId')
  @RequirePermission(R, 'edit')
  async removeDocument(@Req() req: any, @Param('id') id: string, @Param('docId') docId: string) {
    return this.ok(await this.workspace.removeDocument(callerFromRequest(req), id, docId));
  }

  // ── submissions ──
  @Get('submissions')
  @RequirePermission(R, 'view')
  async listSubmissions(
    @Req() req: any, @Query('leadId') leadId?: string, @Query('requirementId') requirementId?: string,
    @Query('candidateId') candidateId?: string, @Query('status') status?: string,
  ) {
    return this.ok(await this.submissions.list(callerFromRequest(req), { leadId, requirementId, candidateId, status }));
  }

  @Post('submissions')
  @RequirePermission(R, 'create')
  async submit(@Req() req: any, @Body() dto: CreateSubmissionDto) {
    return this.ok(await this.submissions.create(callerFromRequest(req), dto));
  }

  @Post('submissions/bulk')
  @RequirePermission(R, 'create')
  async bulkSubmit(@Req() req: any, @Body() dto: BulkSubmissionDto) {
    return this.ok(await this.submissions.bulkCreate(callerFromRequest(req), dto));
  }

  @Get('submissions/:id')
  @RequirePermission(R, 'view')
  async getSubmission(@Req() req: any, @Param('id') id: string) {
    return this.ok(await this.submissions.get(callerFromRequest(req), id));
  }

  @Patch('submissions/:id/move')
  @RequirePermission(R, 'edit')
  async moveSubmission(@Req() req: any, @Param('id') id: string, @Body() dto: MoveSubmissionDto) {
    return this.ok(await this.submissions.move(callerFromRequest(req), id, dto));
  }

  @Patch('submissions/:id')
  @RequirePermission(R, 'edit')
  async updateSubmission(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateSubmissionDto) {
    return this.ok(await this.submissions.update(callerFromRequest(req), id, dto));
  }

  @Delete('submissions/:id')
  @RequirePermission(R, 'delete')
  async removeSubmission(@Req() req: any, @Param('id') id: string) {
    return this.ok(await this.submissions.remove(callerFromRequest(req), id));
  }
}
