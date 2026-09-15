import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RequirePermission } from '../../organization/guards/require-permission.decorator';
import { RecruitmentAccessGuard } from '../guards/recruitment-access.guard';
import { InterviewsService } from '../services/interviews.service';
import { OffersService } from '../services/offers.service';
import { callerFromRequest } from '../services/recruitment-caller';
import {
  CreateInterviewDto, CreateOfferDto, OfferHandoffDto, OfferStatusDto, SubmitFeedbackDto, UpdateInterviewDto, UpdateOfferDto,
} from '../dto';

const R = 'recruitment';

/**
 * `/api/v1/recruitment/interviews` + `/offers`. Listing "mine", reading an
 * interview and submitting feedback are open to any member (service checks the
 * caller is an assigned interviewer); everything else is permission-gated.
 */
@Controller('recruitment')
@UseGuards(JwtAuthGuard, RecruitmentAccessGuard)
export class InterviewsController {
  constructor(private readonly interviews: InterviewsService, private readonly offers: OffersService) {}

  private ok<T>(data: T) { return { success: true, data }; }

  @Get('interviews')
  async list(
    @Req() req: any, @Query('scope') scope?: string, @Query('from') from?: string, @Query('to') to?: string,
    @Query('status') status?: string, @Query('openingId') openingId?: string, @Query('candidateId') candidateId?: string,
    @Query('pendingFeedback') pendingFeedback?: string,
  ) {
    return this.ok(await this.interviews.list(callerFromRequest(req), { scope, from, to, status, openingId, candidateId, pendingFeedback }));
  }

  @Post('interviews')
  @RequirePermission(R, 'edit')
  async create(@Req() req: any, @Body() dto: CreateInterviewDto) {
    return this.ok(await this.interviews.create(callerFromRequest(req), dto));
  }

  @Get('interviews/:id')
  async get(@Req() req: any, @Param('id') id: string) {
    return this.ok(await this.interviews.get(callerFromRequest(req), id));
  }

  @Patch('interviews/:id')
  @RequirePermission(R, 'edit')
  async update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateInterviewDto) {
    return this.ok(await this.interviews.update(callerFromRequest(req), id, dto));
  }

  @Delete('interviews/:id')
  @RequirePermission(R, 'delete')
  async remove(@Req() req: any, @Param('id') id: string) {
    return this.ok(await this.interviews.remove(callerFromRequest(req), id));
  }

  @Post('interviews/:id/feedback')
  async feedback(@Req() req: any, @Param('id') id: string, @Body() dto: SubmitFeedbackDto) {
    return this.ok(await this.interviews.submitFeedback(callerFromRequest(req), id, dto));
  }

  // ── offers ──
  @Get('offers')
  @RequirePermission(R, 'view')
  async listOffers(@Req() req: any, @Query('status') status?: string, @Query('openingId') openingId?: string, @Query('candidateId') candidateId?: string) {
    return this.ok(await this.offers.list(callerFromRequest(req), { status, openingId, candidateId }));
  }

  @Post('offers')
  @RequirePermission(R, 'edit')
  async createOffer(@Req() req: any, @Body() dto: CreateOfferDto) {
    return this.ok(await this.offers.create(callerFromRequest(req), dto));
  }

  @Patch('offers/:id')
  @RequirePermission(R, 'edit')
  async updateOffer(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateOfferDto) {
    return this.ok(await this.offers.update(callerFromRequest(req), id, dto));
  }

  @Post('offers/:id/status')
  @RequirePermission(R, 'edit')
  async offerStatus(@Req() req: any, @Param('id') id: string, @Body() dto: OfferStatusDto) {
    return this.ok(await this.offers.setStatus(callerFromRequest(req), id, dto));
  }

  @Post('offers/:id/handoff')
  @RequirePermission(R, 'edit')
  async handoff(@Req() req: any, @Param('id') id: string, @Body() dto: OfferHandoffDto) {
    return this.ok(await this.offers.handoff(callerFromRequest(req), id, dto));
  }

  @Delete('offers/:id')
  @RequirePermission(R, 'delete')
  async removeOffer(@Req() req: any, @Param('id') id: string) {
    return this.ok(await this.offers.remove(callerFromRequest(req), id));
  }
}
