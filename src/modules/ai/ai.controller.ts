import { Body, Controller, ForbiddenException, Get, Post, Query, Req, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AiService, AiCaller } from './services/ai.service';
import { AiUsageService } from './services/ai-usage.service';
import { CompleteDto } from './dto';

/**
 * AI runtime HTTP surface — `/api/v1/ai/*`, all JWT-guarded and org-scoped.
 * The acting org + user ALWAYS come from `req.user` (the trusted JWT), never the
 * body, so one tenant can neither spend nor read another's AI usage.
 *
 *   POST /ai/complete  — run a completion through the active provider, meter it,
 *                        return the text + token counts.
 *   GET  /ai/usage     — the caller's org balance for the current (or ?period=)
 *                        month, plus the full monthly series.
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
      { model: dto.model, temperature: dto.temperature, maxTokens: dto.maxTokens, feature: 'complete' },
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
}
