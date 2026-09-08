import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AiCaller } from '../ai/services/ai.service';
import { KnowledgeIngestionService } from './knowledge-ingestion.service';
import { KnowledgeQaService } from './knowledge-qa.service';
import { KnowledgeAdminGuard } from './knowledge-admin.guard';
import { AskDto } from './dto';

/**
 * Org document-RAG HTTP surface — `/api/v1/ai/*`, all JWT-guarded and org-scoped.
 * The acting org + user ALWAYS come from `req.user` (the trusted JWT), never the
 * body, so one tenant can neither index nor query another's corpus.
 *
 *   POST /ai/ask                — retrieve org context + answer through AiService
 *                                 (feature `org_qa`, so policy + metering apply).
 *   POST /ai/knowledge/reindex  — (re)index the caller's org corpus. Admin/owner.
 *   GET  /ai/knowledge/status   — indexed doc/chunk counts + last index time. Admin.
 */
@Controller('ai')
@UseGuards(JwtAuthGuard)
export class KnowledgeController {
  constructor(
    private readonly ingestion: KnowledgeIngestionService,
    private readonly qa: KnowledgeQaService,
  ) {}

  private orgId(req: any): string {
    const id = req.user?.organizationId;
    if (!id) throw new ForbiddenException('No organization context');
    return id;
  }

  private callerOf(req: any): AiCaller {
    return { organizationId: req.user?.organizationId ?? null, userId: req.user?.userId ?? null };
  }

  /** Ask a question grounded in the org's indexed documents. Any org member. */
  @Post('ask')
  async ask(@Req() req: any, @Body() dto: AskDto) {
    const orgId = this.orgId(req);
    const result = await this.qa.ask(orgId, dto.question, this.callerOf(req), dto.topK);
    return {
      success: true,
      data: {
        answer: result.answer,
        sources: result.sources,
        grounded: result.grounded,
      },
    };
  }

  /** (Re)index the caller's org corpus. Owner/admin only. */
  @Post('knowledge/reindex')
  @UseGuards(KnowledgeAdminGuard)
  async reindex(@Req() req: any) {
    const orgId = this.orgId(req);
    const counts = await this.ingestion.reindexOrg(orgId);
    return { success: true, message: 'Org corpus reindexed', data: counts };
  }

  /** Indexed-corpus status for the caller's org. Owner/admin only. */
  @Get('knowledge/status')
  @UseGuards(KnowledgeAdminGuard)
  async status(@Req() req: any) {
    const orgId = this.orgId(req);
    const status = await this.ingestion.getStatus(orgId);
    return { success: true, data: status };
  }
}
