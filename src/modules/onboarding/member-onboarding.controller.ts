import {
  Body,
  Controller,
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
import { OnboardingAccessGuard } from './guards/onboarding-access.guard';
import { RequirePermission } from '../organization/guards/require-permission.decorator';
import { OnboardingLifecycleService } from './services/member-onboarding.service';
import { InitiateOnboardingDto, RejectionDto, SetChecklistItemDto } from './dto';

/**
 * HR-facing employee onboarding lifecycle. Effective paths (global prefix
 * `/api/v1`):
 *   POST /onboarding/lifecycle/initiate
 *   GET  /onboarding/lifecycle
 *   GET  /onboarding/lifecycle/active-membership-ids
 *   GET  /onboarding/lifecycle/:id
 *   POST /onboarding/lifecycle/:id/documents/:key/verify
 *   POST /onboarding/lifecycle/:id/documents/:key/reject
 *   POST /onboarding/lifecycle/:id/complete
 *   POST /onboarding/lifecycle/:id/cancel
 * Gated to owner/admin/HR (or a custom role granting `employees:edit`, i.e. the
 * people-management permission HR holds); the acting org is ALWAYS the JWT's
 * `organizationId`.
 */
@Controller('onboarding/lifecycle')
@UseGuards(JwtAuthGuard, OnboardingAccessGuard)
@RequirePermission('employees', 'edit')
export class MemberOnboardingController {
  constructor(private readonly lifecycle: OnboardingLifecycleService) {}

  private orgId(req: any): string {
    const id = req.user?.organizationId;
    if (!id) throw new Error('No organization context');
    return id;
  }

  @Post('initiate')
  @HttpCode(HttpStatus.CREATED)
  async initiate(@Body() dto: InitiateOnboardingDto, @Req() req: any) {
    const data = await this.lifecycle.initiate(this.orgId(req), dto, req.user.userId);
    return { success: true, message: 'Onboarding started', data };
  }

  @Get()
  async list(@Req() req: any) {
    const data = await this.lifecycle.list(this.orgId(req));
    return { success: true, data };
  }

  /** membershipIds already in an active onboarding — the initiate picker filter. */
  @Get('active-membership-ids')
  async activeIds(@Req() req: any) {
    const data = await this.lifecycle.activeMembershipIds(this.orgId(req));
    return { success: true, data };
  }

  @Get(':id')
  async get(@Param('id') id: string, @Req() req: any) {
    const data = await this.lifecycle.get(this.orgId(req), id);
    return { success: true, data };
  }

  @Post(':id/documents/:key/verify')
  @HttpCode(HttpStatus.OK)
  async verify(
    @Param('id') id: string,
    @Param('key') key: string,
    @Req() req: any,
  ) {
    const data = await this.lifecycle.verifyDocument(
      this.orgId(req),
      id,
      key,
      req.user.userId,
    );
    return { success: true, message: 'Document verified', data };
  }

  @Post(':id/documents/:key/reject')
  @HttpCode(HttpStatus.OK)
  async reject(
    @Param('id') id: string,
    @Param('key') key: string,
    @Body() dto: RejectionDto,
    @Req() req: any,
  ) {
    const data = await this.lifecycle.rejectDocument(
      this.orgId(req),
      id,
      key,
      dto.note,
      req.user.userId,
    );
    return { success: true, message: 'Document rejected', data };
  }

  /** HR/manager ticks (or re-opens) any checklist item — incl. the IT/HR tasks. */
  @Put(':id/checklist/:key')
  @HttpCode(HttpStatus.OK)
  async setChecklistItem(
    @Param('id') id: string,
    @Param('key') key: string,
    @Body() dto: SetChecklistItemDto,
    @Req() req: any,
  ) {
    const data = await this.lifecycle.setChecklistItemStatus(
      this.orgId(req),
      id,
      key,
      dto.done,
      req.user.userId,
    );
    return {
      success: true,
      message: dto.done ? 'Task marked done' : 'Task re-opened',
      data,
    };
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  async complete(@Param('id') id: string, @Req() req: any) {
    const data = await this.lifecycle.complete(this.orgId(req), id);
    return { success: true, message: 'Onboarding completed', data };
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(@Param('id') id: string, @Req() req: any) {
    const data = await this.lifecycle.cancel(this.orgId(req), id);
    return { success: true, message: 'Onboarding cancelled', data };
  }
}
