import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RequirePermission } from '../../organization/guards/require-permission.decorator';
import { RecruitmentAccessGuard } from '../guards/recruitment-access.guard';
import { CandidatesService, CandidateListQuery } from '../services/candidates.service';
import { ImportExportService } from '../services/import-export.service';
import { MatchingService } from '../services/matching.service';
import { callerFromRequest } from '../services/recruitment-caller';
import {
  AddDocumentDto, BulkCandidateActionDto, CandidateFromCvDto, CreateCandidateActivityDto, CreateCandidateDto,
  ImportCandidatesDto, MergeCandidatesDto, UpdateCandidateDto,
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
    private readonly io: ImportExportService,
    private readonly matching: MatchingService,
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

  @Get('pool-counts')
  @RequirePermission(R, 'view')
  async poolCounts(@Req() req: any) {
    return this.ok(await this.candidates.poolCounts(callerFromRequest(req)));
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

  /** Preview a freshly uploaded CV before it is attached (Word → HTML; `{ kind: 'file' }` for PDFs/images). */
  @Get('files/:fileId/preview')
  @RequirePermission(R, 'create')
  async filePreview(@Req() req: any, @Param('fileId') fileId: string) {
    return this.ok(await this.candidates.filePreview(callerFromRequest(req), fileId));
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

  @Get(':id/suggestions')
  @RequirePermission(R, 'view')
  async suggestions(@Req() req: any, @Param('id') id: string) {
    return this.ok(await this.matching.suggestionsFor(callerFromRequest(req), id));
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

  /** The file itself, for viewing in the portal (PDF/image inline). Same access as `access`; audited. */
  @Get(':id/documents/:docId/file')
  async documentFile(@Req() req: any, @Res() res: Response, @Param('id') id: string, @Param('docId') docId: string) {
    const { file, bytes } = await this.candidates.documentFile(callerFromRequest(req), id, docId);
    const safeName = (file.originalName || 'document').replace(/[^\w.\-]+/g, '_');
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(bytes);
  }

  /** A Word CV rendered as HTML for the viewer; `{ kind: 'file' }` for anything shown directly. */
  @Get(':id/documents/:docId/preview')
  async documentPreview(@Req() req: any, @Param('id') id: string, @Param('docId') docId: string) {
    return this.ok(await this.candidates.documentPreview(callerFromRequest(req), id, docId));
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
