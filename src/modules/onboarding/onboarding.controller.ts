import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OnboardingOwnerGuard } from './guards/onboarding-owner.guard';
import { OnboardingService } from './services/onboarding.service';
import { SubmitDocumentDto } from './dto';

/**
 * Owner-facing onboarding surface — the "temp login" area an org owner can reach
 * while their org is still in `onboarding`. Effective paths (global prefix):
 *   GET  /onboarding                      — status + document checklist
 *   GET  /onboarding/documents/:id        — one document
 *   POST /onboarding/documents/:id/submit — sign / upload a document
 * The acting org is ALWAYS the JWT's `organizationId`.
 */
@Controller('onboarding')
@UseGuards(JwtAuthGuard, OnboardingOwnerGuard)
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get()
  async status(@Req() req: any) {
    return {
      success: true,
      data: await this.onboarding.ownerStatus(req.user.organizationId),
    };
  }

  @Get('documents/:id')
  async getDocument(@Param('id') id: string, @Req() req: any) {
    return {
      success: true,
      data: await this.onboarding.ownerGetDocument(
        req.user.organizationId,
        id,
      ),
    };
  }

  @Post('documents/:id/submit')
  async submit(
    @Param('id') id: string,
    @Body() dto: SubmitDocumentDto,
    @Req() req: any,
  ) {
    const ip =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.ip;
    const ua = req.headers['user-agent'] as string;
    const data = await this.onboarding.submitDocument(
      req.user.organizationId,
      id,
      dto,
      req.user.userId,
      ip,
      ua,
    );
    return { success: true, message: 'Document submitted', data };
  }
}
