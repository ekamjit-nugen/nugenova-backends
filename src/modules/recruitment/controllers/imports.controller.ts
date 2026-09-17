import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RequirePermission } from '../../organization/guards/require-permission.decorator';
import { CreateImportJobDto } from '../dto';
import { RecruitmentAccessGuard } from '../guards/recruitment-access.guard';
import { ImportJobsService } from '../services/import-jobs.service';
import { callerFromRequest } from '../services/recruitment-caller';

const R = 'recruitment';

/**
 * `/api/v1/recruitment/imports` — background spreadsheet imports. Starting one
 * answers immediately (202); progress is read from the job while rows are saved.
 */
@Controller('recruitment/imports')
@UseGuards(JwtAuthGuard, RecruitmentAccessGuard)
export class ImportsController {
  constructor(private readonly imports: ImportJobsService) {}

  private ok<T>(data: T) { return { success: true, data }; }

  @Post()
  @HttpCode(202)
  @RequirePermission(R, 'create')
  async start(@Req() req: any, @Body() dto: CreateImportJobDto) {
    const { job, duplicate } = await this.imports.enqueue(callerFromRequest(req), dto);
    return { success: true, data: job, duplicate };
  }

  @Get()
  @RequirePermission(R, 'view')
  async list(@Req() req: any, @Query('limit') limit?: string, @Query('includeDismissed') includeDismissed?: string) {
    return this.ok(await this.imports.list(callerFromRequest(req), { limit: Number(limit) || undefined, includeDismissed: includeDismissed === '1' || includeDismissed === 'true' }));
  }

  @Get(':id')
  @RequirePermission(R, 'view')
  async get(@Req() req: any, @Param('id') id: string) {
    return this.ok(await this.imports.get(callerFromRequest(req), id));
  }

  @Get(':id/rows')
  @RequirePermission(R, 'view')
  async rows(@Req() req: any, @Param('id') id: string, @Query('filter') filter?: string, @Query('page') page?: string, @Query('limit') limit?: string) {
    return this.ok(await this.imports.listRows(callerFromRequest(req), id, { filter, page: Number(page) || undefined, limit: Number(limit) || undefined }));
  }

  @Post(':id/cancel')
  @RequirePermission(R, 'create')
  async cancel(@Req() req: any, @Param('id') id: string) {
    return this.ok(await this.imports.cancel(callerFromRequest(req), id));
  }

  @Post(':id/retry')
  @RequirePermission(R, 'create')
  async retry(@Req() req: any, @Param('id') id: string) {
    return this.ok(await this.imports.retry(callerFromRequest(req), id));
  }

  @Post(':id/dismiss')
  @RequirePermission(R, 'view')
  async dismiss(@Req() req: any, @Param('id') id: string) {
    return this.ok(await this.imports.dismiss(callerFromRequest(req), id));
  }
}
