import { Body, Controller, ForbiddenException, Get, Post, Query, Req, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AiService, AiCaller } from './services/ai.service';
import { AiUsageService } from './services/ai-usage.service';
import { CompleteDto, UsageEventsQueryDto } from './dto';
import { AiUsageRoleGuard } from './guards/ai-usage-role.guard';

/**
 * AI runtime HTTP surface — `/api/v1/ai/*`, all JWT-guarded and org-scoped.
 * The acting org + user ALWAYS come from `req.user` (the trusted JWT), never the
 * body, so one tenant can neither spend nor read another's AI usage.
 *
 *   POST /ai/complete       — run a completion through the active provider, meter
 *                             it, return the text + token counts.
 *   GET  /ai/usage          — the caller's org balance for the current (or
 *                             ?period=) month, plus the full monthly series.
 *   GET  /ai/usage/events   — paginated event ledger (owner/admin/hr).
 *   GET  /ai/usage/by-user  — per-user rollup (owner/admin/hr).
 *   GET  /ai/usage/summary  — all-time org totals (owner/admin/hr).
 */
@Controller('ai')
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly usage: AiUsageService,
  ) {}

  private callerOf(req: any): AiCaller {
    return { organizationId: req.user?.organizationId ?? null, userId: req.user?.userId ?? null };
  }

  private orgId(req: any): string {
    const id = req.user?.organizationId;
    if (!id) throw new ForbiddenException('No organization context');
    return id;
  }

  /** Run a completion. Records usage; returns the generated text + token usage. */
  @Post('complete')
  async complete(@Req() req: any, @Body() dto: CompleteDto) {
    const result = await this.ai.complete(
      dto.messages,
      {
        model: dto.model,
        temperature: dto.temperature,
        maxTokens: dto.maxTokens,
        feature: 'complete',
        tier: dto.tier,
        subjectMembershipId: dto.subjectMembershipId,
      },
      this.callerOf(req),
    );
    return {
      success: true,
      message: 'AI response generated',
      data: {
        text: result.text,
        provider: result.provider,
        model: result.model,
        usage: result.usage,
      },
    };
  }

  /** The caller's org AI-credit balance: current-period (or ?period=YYYY-MM) + series. */
  @Get('usage')
  async usageBalance(@Req() req: any, @Query('period') period?: string) {
    const orgId = this.orgId(req);
    const [balance, series] = await Promise.all([
      this.usage.getOrgBalance(orgId, period),
      this.usage.getOrgSeries(orgId),
    ]);
    return { success: true, data: { balance, series } };
  }

  /**
   * Paginated AI event ledger for the caller's org — one row per call with the
   * token split, redaction-aware prompt/output, and the resolved actor. Filter
   * by ?userId=/?feature=/?projectId=, page with ?page=/?limit=. Owner/admin/hr.
   */
  @Get('usage/events')
  @UseGuards(AiUsageRoleGuard)
  async usageEvents(@Req() req: any, @Query() query: UsageEventsQueryDto) {
    const orgId = this.orgId(req);
    const { data, pagination } = await this.usage.listEvents(orgId, {
      userId: query.userId,
      feature: query.feature,
      projectId: query.projectId,
      page: query.page,
      limit: query.limit,
    });
    return { success: true, data, pagination };
  }

  /** Per-user token rollup for the caller's org, biggest consumers first. Owner/admin/hr. */
  @Get('usage/by-user')
  @UseGuards(AiUsageRoleGuard)
  async usageByUser(@Req() req: any) {
    const orgId = this.orgId(req);
    const data = await this.usage.rollupByUser(orgId);
    return { success: true, data };
  }

  /** All-time AI usage totals for the caller's org (+ userCount). Owner/admin/hr. */
  @Get('usage/summary')
  @UseGuards(AiUsageRoleGuard)
  async usageSummary(@Req() req: any) {
    const orgId = this.orgId(req);
    const data = await this.usage.summary(orgId);
    return { success: true, data };
  }
}
