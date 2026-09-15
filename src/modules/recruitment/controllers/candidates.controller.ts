import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RequirePermission } from '../../organization/guards/require-permission.decorator';
import { RecruitmentAccessGuard } from '../guards/recruitment-access.guard';
import { CandidatesService, CandidateListQuery } from '../services/candidates.service';
import { CvParseService } from '../services/cv-parse.service';
import { ImportExportService } from '../services/import-export.service';
import { callerFromRequest } from '../services/recruitment-caller';
import {
  AddDocumentDto, BulkCandidateActionDto, CandidateFromCvDto, CreateCandidateActivityDto, CreateCandidateDto,
  ImportCandidatesDto, MergeCandidatesDto, ParseCvDto, UpdateCandidateDto,
} from '../dto';

const R = 'recruitment';

/**
 * `/api/v1/recruitment/candidates` — the talent pool. Static routes are declared
 * before `:id`. `GET :id` and document access are undecorated so an assigned
 * interviewer can open the candidate they're interviewing (service-enforced).
 */
@Controller('recruitment/candidates')
@UseGuards(JwtAuthGuard, RecruitmentAccessGuard)
export class CandidatesController {
  constructor(
    private readonly candidates: CandidatesService,
    private readonly cv: CvParseService,
    private readonly io: ImportExportService,
  ) {}

  private ok<T>(data: T) { return { success: true, data }; }

  @Get()
  @RequirePermission(R, 'view')
  async list(@Req() req: any, @Query() q: CandidateListQuery) {
    return this.ok(await this.candidates.list(callerFromRequest(req), q));
  }

  @Get('export')
  @RequirePermission(R, 'export')
  async export(@Req() req: any, @Query() q: CandidateListQuery) {
    return this.ok(await this.io.exportRows(callerFromRequest(req), q));
  }

  @Get('duplicates')
  @RequirePermission(R, 'view')
  async duplicates(@Req() req: any, @Query('email') email?: string, @Query('phone') phone?: string, @Query('name') name?: string, @Query('excludeId') excludeId?: string) {
    return this.ok(await this.candidates.duplicates(callerFromRequest(req), { email, phone, name, excludeId }));
  }

  @Post('import')
  @RequirePermission(R, 'create')
  async import(@Req() req: any, @Body() dto: ImportCandidatesDto) {
    return this.ok(await this.io.importRows(callerFromRequest(req), dto));
  }

  @Post('parse')
  @RequirePermission(R, 'create')
  async parse(@Req() req: any, @Body() dto: ParseCvDto) {
    return this.ok(await this.cv.parse(callerFromRequest(req), dto.fileId, { skipAi: dto.skipAi }));
  }

  @Post('from-cv')
  @RequirePermission(R, 'create')
  async fromCv(@Req() req: any, @Body() dto: CandidateFromCvDto) {
    return this.ok(await this.candidates.fromCv(callerFromRequest(req), dto));
  }

  @Post('merge')
  @RequirePermission(R, 'edit')
  async merge(@Req() req: any, @Body() dto: MergeCandidatesDto) {
    return this.ok(await this.candidates.merge(callerFromRequest(req), dto));
  }

  @Post('bulk')
  @RequirePermission(R, 'edit')
  async bulk(@Req() req: any, @Body() dto: BulkCandidateActionDto) {
    return this.ok(await this.candidates.bulk(callerFromRequest(req), dto));
  }

  @Post()
  @RequirePermission(R, 'create')
  async create(@Req() req: any, @Body() dto: CreateCandidateDto) {
    return this.ok(await this.candidates.create(callerFromRequest(req), dto));
  }

  // ── :id ──

  @Get(':id')
  async get(@Req() req: any, @Param('id') id: string) {
    return this.ok(await this.candidates.get(callerFromRequest(req), id));
  }

  @Patch(':id')
  @RequirePermission(R, 'edit')
  async update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateCandidateDto) {
    return this.ok(await this.candidates.update(callerFromRequest(req), id, dto));
  }

  @Delete(':id')
  @RequirePermission(R, 'delete')
  async remove(@Req() req: any, @Param('id') id: string) {
    return this.ok(await this.candidates.remove(callerFromRequest(req), id));
  }

  @Post(':id/documents')
  @RequirePermission(R, 'edit')
  async addDocument(@Req() req: any, @Param('id') id: string, @Body() dto: AddDocumentDto) {
    return this.ok(await this.candidates.addDocument(callerFromRequest(req), id, dto));
  }

  @Get(':id/documents/:docId/access')
  async accessDocument(@Req() req: any, @Param('id') id: string, @Param('docId') docId: string) {
    return this.ok(await this.candidates.accessDocument(callerFromRequest(req), id, docId));
  }

  @Post(':id/documents/:docId/primary')
  @RequirePermission(R, 'edit')
  async setPrimary(@Req() req: any, @Param('id') id: string, @Param('docId') docId: string) {
    return this.ok(await this.candidates.setPrimaryDocument(callerFromRequest(req), id, docId));
  }

  @Delete(':id/documents/:docId')
  @RequirePermission(R, 'edit')
  async removeDocument(@Req() req: any, @Param('id') id: string, @Param('docId') docId: string) {
    return this.ok(await this.candidates.removeDocument(callerFromRequest(req), id, docId));
  }

  @Post(':id/activities')
  @RequirePermission(R, 'view')
  async addActivity(@Req() req: any, @Param('id') id: string, @Body() dto: CreateCandidateActivityDto) {
    return this.ok(await this.candidates.addActivity(callerFromRequest(req), id, dto));
  }

  @Delete(':id/activities/:activityId')
  @RequirePermission(R, 'view')
  async deleteActivity(@Req() req: any, @Param('id') id: string, @Param('activityId') activityId: string) {
    return this.ok(await this.candidates.deleteActivity(callerFromRequest(req), id, activityId));
  }
}
