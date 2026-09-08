import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { GuardianAccessGuard } from './guards/guardian-access.guard';
import { GuardianService } from './guardian.service';
import { LinkGuardianDto, RecordConsentDto, RevokeConsentDto } from './dto';

/**
 * Guardian links + consent ledger (`/api/v1/guardian`). Owner/admin only
 * (GuardianAccessGuard) — the registrar-facing surface — always scoped to the
 * JWT's org. Links map guardian↔student memberships; the consent ledger records
 * the per-learner, per-purpose consent §09 tiers 2–3 gate on. See PLAYBOOK.md.
 */
@Controller('guardian')
@UseGuards(JwtAuthGuard, GuardianAccessGuard)
export class GuardianController {
  constructor(private readonly guardian: GuardianService) {}

  private orgId(req: any): string {
    const id = req.user?.organizationId;
    if (!id) throw new Error('No organization context');
    return id;
  }

  // ── links ─────────────────────────────────────────────────────────────────

  @Post('links')
  @HttpCode(HttpStatus.CREATED)
  async link(@Body() dto: LinkGuardianDto, @Req() req: any) {
    const data = await this.guardian.linkGuardian(
      this.orgId(req),
      dto,
      req.user.userId,
    );
    return { success: true, data };
  }

  @Delete('links/:linkId')
  async unlink(@Param('linkId') linkId: string, @Req() req: any) {
    const data = await this.guardian.unlinkGuardian(
      this.orgId(req),
      linkId,
      req.user.userId,
    );
    return { success: true, data };
  }

  /** Guardians of a student, or students of a guardian (one query param). */
  @Get('links')
  async listLinks(
    @Req() req: any,
    @Query('studentMembershipId') studentMembershipId?: string,
    @Query('guardianMembershipId') guardianMembershipId?: string,
  ) {
    const orgId = this.orgId(req);
    if (studentMembershipId) {
      const data = await this.guardian.listGuardiansOf(orgId, studentMembershipId);
      return { success: true, data };
    }
    if (guardianMembershipId) {
      const data = await this.guardian.listStudentsOf(orgId, guardianMembershipId);
      return { success: true, data };
    }
    return { success: true, data: [] };
  }

  // ── consent ─────────────────────────────────────────────────────────────────

  @Post('consent')
  @HttpCode(HttpStatus.CREATED)
  async recordConsent(@Body() dto: RecordConsentDto, @Req() req: any) {
    const data = await this.guardian.recordConsent(
      this.orgId(req),
      dto,
      req.user.userId,
    );
    return { success: true, data };
  }

  @Post('consent/revoke')
  async revokeConsent(@Body() dto: RevokeConsentDto, @Req() req: any) {
    const data = await this.guardian.revokeConsent(
      this.orgId(req),
      dto,
      req.user.userId,
    );
    return { success: true, data };
  }

  /** The full consent ledger for a learner (active + revoked). */
  @Get('consent/:subjectMembershipId')
  async listConsent(
    @Param('subjectMembershipId') subjectMembershipId: string,
    @Req() req: any,
  ) {
    const data = await this.guardian.listConsent(
      this.orgId(req),
      subjectMembershipId,
    );
    return { success: true, data };
  }

  /** Whether a purpose is currently consented for a learner. */
  @Get('consent/:subjectMembershipId/check')
  async checkConsent(
    @Param('subjectMembershipId') subjectMembershipId: string,
    @Query('purpose') purpose: string,
    @Req() req: any,
  ) {
    const consented = await this.guardian.isConsented(
      this.orgId(req),
      subjectMembershipId,
      purpose ?? '',
    );
    return { success: true, data: { subjectMembershipId, purpose, consented } };
  }
}
