import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OnboardingLifecycleService } from './services/member-onboarding.service';
import { UploadOnboardingDocumentDto } from './dto';

/**
 * Employee self-service "My Onboarding". Effective paths (global prefix):
 *   GET  /onboarding/me                        — my active onboarding (or null)
 *   POST /onboarding/me/documents/:key/upload  — attach an uploaded file to a slot
 *   POST /onboarding/me/checklist/:key/complete — tick a self-serviceable task
 * Any authenticated member; the service resolves the caller → their onboarding
 * within the JWT's org. Only owner/HR-owned tasks are blocked (service-enforced).
 */
@Controller('onboarding/me')
@UseGuards(JwtAuthGuard)
export class MyOnboardingController {
  constructor(private readonly lifecycle: OnboardingLifecycleService) {}

  private orgId(req: any): string {
    const id = req.user?.organizationId;
    if (!id) throw new Error('No organization context');
    return id;
  }

  @Get()
  async mine(@Req() req: any) {
    const data = await this.lifecycle.getMyOnboarding(
      this.orgId(req),
      req.user.userId,
    );
    return { success: true, data };
  }

  @Post('documents/:key/upload')
  @HttpCode(HttpStatus.OK)
  async upload(
    @Param('key') key: string,
    @Body() dto: UploadOnboardingDocumentDto,
    @Req() req: any,
  ) {
    const data = await this.lifecycle.uploadMyDocument(
      this.orgId(req),
      req.user.userId,
      key,
      dto.fileId,
    );
    return { success: true, message: 'Document uploaded', data };
  }

  @Post('checklist/:key/complete')
  @HttpCode(HttpStatus.OK)
  async completeTask(@Param('key') key: string, @Req() req: any) {
    const data = await this.lifecycle.completeMyChecklistItem(
      this.orgId(req),
      req.user.userId,
      key,
    );
    return { success: true, message: 'Task completed', data };
  }
}
