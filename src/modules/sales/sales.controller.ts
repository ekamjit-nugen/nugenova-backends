import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SalesCaller, SalesService } from './sales.service';
import {
  CreateAccountDto, CreateActivityDto, CreateContactDto, CreateFollowupDto, CreateLeadDto, CreateLeadDocumentDto,
  CreateQuoteDto, CreateRequirementDto, CreateStageDto, MoveStageDto, UpdateAccountDto, UpdateContactDto,
  UpdateFollowupDto, UpdateLeadDto, UpdateQuoteDto, UpdateRequirementDto,
} from './dto';

/**
 * Sales & Leads — `/api/v1/sales`. JWT-guarded, org-scoped. Open to any org
 * member (sales reps); per-rep row scoping is a later phase.
 *
 * NOTE: `@RequireModule('sales')` will be added once the ModuleEnabledGuard infra
 * merges to main (as with the clients module).
 */
@Controller('sales')
@UseGuards(JwtAuthGuard)
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  private caller(req: any): SalesCaller {
    const orgId = req.user?.organizationId;
    if (!orgId) throw new ForbiddenException('No organization context');
    return { userId: req.user?.userId, orgId, isAdmin: req.user?.orgRole === 'owner' || req.user?.orgRole === 'admin' };
  }
  private ok<T>(data: T) { return { success: true, data }; }

  // ── pipeline stages ──
  @Get('stages')
  async stages(@Req() req: any) { return this.ok(await this.sales.listStages(this.caller(req).orgId)); }

  @Post('stages')
  async createStage(@Req() req: any, @Body() dto: CreateStageDto) { return this.ok(await this.sales.createStage(this.caller(req), dto)); }

  // ── dashboard + follow-ups (static before :id) ──
  @Get('overview')
  async overview(@Req() req: any) { return this.ok(await this.sales.overview(this.caller(req).orgId)); }

  @Get('analytics')
  async analytics(@Req() req: any) { return this.ok(await this.sales.analytics(this.caller(req).orgId)); }

  // ── import / export (Excel migration path) ──
  @Get('leads/export')
  async exportLeads(@Req() req: any) {
    const csv = await this.sales.exportLeadsCsv(this.caller(req).orgId);
    return this.ok({ csv, filename: `leads-${new Date().toISOString().slice(0, 10)}.csv` });
  }

  @Post('leads/import')
  async importLeads(@Req() req: any, @Body() body: { rows?: Array<Record<string, any>> }) {
    return this.ok(await this.sales.importLeads(this.caller(req), body?.rows ?? []));
  }

  @Get('followups')
  async followups(@Req() req: any, @Query('mine') mine?: string) {
    const c = this.caller(req);
    return this.ok(await this.sales.listFollowups(c.orgId, mine === '1' ? c.userId : undefined));
  }

  @Patch('followups/:id')
  async updateFollowup(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateFollowupDto) {
    return this.ok(await this.sales.updateFollowup(this.caller(req).orgId, id, dto));
  }

  // ── leads ──
  @Get('leads/board')
  async board(@Req() req: any, @Query('closed') closed?: string) {
    return this.ok(await this.sales.board(this.caller(req).orgId, closed === '1'));
  }

  @Get('leads')
  async listLeads(@Req() req: any, @Query('status') status?: string, @Query('stageId') stageId?: string, @Query('assignedTo') assignedTo?: string, @Query('source') source?: string, @Query('q') q?: string) {
    return this.ok(await this.sales.listLeads(this.caller(req).orgId, { status, stageId, assignedTo, source, q }));
  }

  @Post('leads')
  async createLead(@Req() req: any, @Body() dto: CreateLeadDto) { return this.ok(await this.sales.createLead(this.caller(req), dto)); }

  @Get('leads/:id')
  async getLead(@Req() req: any, @Param('id') id: string) { return this.ok(await this.sales.getLead(this.caller(req).orgId, id)); }

  @Patch('leads/:id')
  async updateLead(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateLeadDto) { return this.ok(await this.sales.updateLead(this.caller(req), id, dto)); }

  @Post('leads/:id/move')
  async moveStage(@Req() req: any, @Param('id') id: string, @Body() dto: MoveStageDto) { return this.ok(await this.sales.moveStage(this.caller(req), id, dto)); }

  @Delete('leads/:id')
  async deleteLead(@Req() req: any, @Param('id') id: string) { return this.ok(await this.sales.deleteLead(this.caller(req).orgId, id)); }

  @Post('leads/:id/activities')
  async addLeadActivity(@Req() req: any, @Param('id') id: string, @Body() dto: CreateActivityDto) {
    return this.ok(await this.sales.addActivity(this.caller(req), 'lead', id, dto));
  }

  @Post('leads/:id/followups')
  async addLeadFollowup(@Req() req: any, @Param('id') id: string, @Body() dto: CreateFollowupDto) {
    return this.ok(await this.sales.addFollowup(this.caller(req), 'lead', id, dto));
  }

  @Get('leads/:id/requirements')
  async leadRequirements(@Req() req: any, @Param('id') id: string) {
    return this.ok(await this.sales.listRequirements(this.caller(req).orgId, 'lead', id));
  }

  @Post('leads/:id/requirements')
  async addLeadRequirement(@Req() req: any, @Param('id') id: string, @Body() dto: CreateRequirementDto) {
    return this.ok(await this.sales.addRequirement(this.caller(req), 'lead', id, dto));
  }

  @Post('leads/:id/rollup')
  async rollupLead(@Req() req: any, @Param('id') id: string) { return this.ok(await this.sales.rollupLeadValue(this.caller(req), id)); }

  @Post('leads/:id/convert-to-client')
  async convertLeadToClient(@Req() req: any, @Param('id') id: string) { return this.ok(await this.sales.convertLeadToClient(this.caller(req), id)); }

  // ── lead documents ──
  @Get('leads/:id/documents')
  async leadDocuments(@Req() req: any, @Param('id') id: string) { return this.ok(await this.sales.listDocuments(this.caller(req).orgId, id)); }
  @Post('leads/:id/documents')
  async addLeadDocument(@Req() req: any, @Param('id') id: string, @Body() dto: CreateLeadDocumentDto) { return this.ok(await this.sales.addDocument(this.caller(req), id, dto)); }
  @Delete('leads/:id/documents/:docId')
  async removeLeadDocument(@Req() req: any, @Param('id') id: string, @Param('docId') docId: string) { return this.ok(await this.sales.removeDocument(this.caller(req).orgId, id, docId)); }

  // ── lead quotes ──
  @Get('leads/:id/quotes')
  async leadQuotes(@Req() req: any, @Param('id') id: string) { return this.ok(await this.sales.listQuotes(this.caller(req).orgId, 'lead', id)); }
  @Post('leads/:id/quotes')
  async createLeadQuote(@Req() req: any, @Param('id') id: string, @Body() dto: CreateQuoteDto) { return this.ok(await this.sales.createQuote(this.caller(req), 'lead', id, dto)); }
  @Post('leads/:id/quotes/from-requirements')
  async leadQuoteFromReqs(@Req() req: any, @Param('id') id: string) { return this.ok(await this.sales.quoteFromRequirements(this.caller(req), 'lead', id)); }

  // ── quotes (by id) ──
  @Get('quotes/:id')
  async getQuote(@Req() req: any, @Param('id') id: string) { return this.ok(await this.sales.getQuote(this.caller(req).orgId, id)); }
  @Patch('quotes/:id')
  async updateQuote(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateQuoteDto) { return this.ok(await this.sales.updateQuote(this.caller(req).orgId, id, dto)); }
  @Post('quotes/:id/send')
  async sendQuote(@Req() req: any, @Param('id') id: string) { return this.ok(await this.sales.setQuoteStatus(this.caller(req).orgId, id, 'sent')); }
  @Post('quotes/:id/accept')
  async acceptQuote(@Req() req: any, @Param('id') id: string) { return this.ok(await this.sales.setQuoteStatus(this.caller(req).orgId, id, 'accepted')); }
  @Post('quotes/:id/reject')
  async rejectQuote(@Req() req: any, @Param('id') id: string) { return this.ok(await this.sales.setQuoteStatus(this.caller(req).orgId, id, 'rejected')); }
  @Delete('quotes/:id')
  async deleteQuote(@Req() req: any, @Param('id') id: string) { return this.ok(await this.sales.deleteQuote(this.caller(req).orgId, id)); }

  // ── requirements (by id) ──
  @Patch('requirements/:id')
  async updateRequirement(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateRequirementDto) {
    return this.ok(await this.sales.updateRequirement(this.caller(req).orgId, id, dto));
  }

  @Delete('requirements/:id')
  async deleteRequirement(@Req() req: any, @Param('id') id: string) {
    return this.ok(await this.sales.deleteRequirement(this.caller(req).orgId, id));
  }

  // ── accounts ──
  @Get('accounts')
  async listAccounts(@Req() req: any, @Query('q') q?: string) { return this.ok(await this.sales.listAccounts(this.caller(req).orgId, q)); }
  @Post('accounts')
  async createAccount(@Req() req: any, @Body() dto: CreateAccountDto) { return this.ok(await this.sales.createAccount(this.caller(req), dto)); }
  @Patch('accounts/:id')
  async updateAccount(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateAccountDto) { return this.ok(await this.sales.updateAccount(this.caller(req).orgId, id, dto)); }
  @Delete('accounts/:id')
  async deleteAccount(@Req() req: any, @Param('id') id: string) { return this.ok(await this.sales.deleteAccount(this.caller(req).orgId, id)); }

  // ── contacts ──
  @Get('contacts')
  async listContacts(@Req() req: any, @Query('q') q?: string) { return this.ok(await this.sales.listContacts(this.caller(req).orgId, q)); }
  @Post('contacts')
  async createContact(@Req() req: any, @Body() dto: CreateContactDto) { return this.ok(await this.sales.createContact(this.caller(req), dto)); }
  @Patch('contacts/:id')
  async updateContact(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateContactDto) { return this.ok(await this.sales.updateContact(this.caller(req).orgId, id, dto)); }
  @Delete('contacts/:id')
  async deleteContact(@Req() req: any, @Param('id') id: string) { return this.ok(await this.sales.deleteContact(this.caller(req).orgId, id)); }
}
