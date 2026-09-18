import { Body, Controller, Delete, ForbiddenException, Get, Ip, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { permMapAllows } from '../organization/guards/require-permission.decorator';
import { ClientsCaller, ClientsService } from './clients.service';
import {
  AssignEmployeeDto, CreateAgreementDto, SetClientPortalDto, CreateAgreementTemplateDto, CreateClientDto, CreateContactDto, CreateDocumentDto, CreateTicketDto, InviteContactDto, PortalCommentDto, PortalUploadDocumentDto, ShareBoardDto, SignAgreementDto, SignDocumentDto, TicketMessageDto, UpdateAgreementDto, UpdateAgreementTemplateDto, UpdateClientDto, UpdateContactDto, UpdateDocumentDto, UpdateTicketDto,
} from './dto';

/**
 * Clients — `/api/v1/clients`. JWT-guarded, org-scoped. Management routes need
 * the matching `clients` permission (view / create / edit / delete) — owners and
 * admins have all of them, custom roles get what the Roles page grants. `mine`
 * and `portal/*` serve assigned employees and client portal users respectively.
 *
 * NOTE: the `clients` module key is registered in vertical-packs; the
 * `@RequireModule('clients')` gate will be added once the ModuleEnabledGuard
 * infra (currently on the meetings/activity branches) merges to main.
 */
type ClientsAction = 'view' | 'create' | 'edit' | 'delete';

@Controller('clients')
@UseGuards(JwtAuthGuard)
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  private caller(req: any): ClientsCaller {
    const orgId = req.user?.organizationId;
    if (!orgId) throw new ForbiddenException('No organization context');
    return { userId: req.user?.userId, orgId, isAdmin: req.user?.orgRole === 'owner' || req.user?.orgRole === 'admin' };
  }

  /**
   * The caller, if they may `action` clients: owner/admin, or a role granted
   * clients:<action>. `alsoAllow` lets another permission through (listing
   * clients for the Sales lead picker).
   */
  private allowed(req: any, action: ClientsAction, alsoAllow?: [string, string]): ClientsCaller {
    const c = this.caller(req);
    if (c.isAdmin) return c;
    const perms = req.user?.perms;
    if (permMapAllows(perms, 'clients', action)) return c;
    if (alsoAllow && permMapAllows(perms, alsoAllow[0], alsoAllow[1])) return c;
    throw new ForbiddenException(`You don't have permission to ${action} clients`);
  }

  // ── static routes first (before :id) ──
  /** Clients the calling employee is assigned to. */
  @Get('mine')
  async mine(@Req() req: any) {
    const c = this.caller(req);
    return { success: true, data: await this.clients.myClients(c.orgId, c.userId) };
  }

  /** Admin dashboard summary — client counts + agreement activity. */
  @Get('overview')
  async overview(@Req() req: any) {
    return { success: true, data: await this.clients.dashboardSummary(this.allowed(req, 'view').orgId) };
  }

  // ── agreement templates (admin, org-level) ──
  @Get('agreement-templates')
  async listTemplates(@Req() req: any) {
    return { success: true, data: await this.clients.listTemplates(this.allowed(req, 'view').orgId) };
  }

  @Post('agreement-templates')
  async createTemplate(@Req() req: any, @Body() dto: CreateAgreementTemplateDto) {
    return { success: true, data: await this.clients.createTemplate(this.allowed(req, 'create'), dto) };
  }

  @Patch('agreement-templates/:tid')
  async updateTemplate(@Req() req: any, @Param('tid') tid: string, @Body() dto: UpdateAgreementTemplateDto) {
    return { success: true, data: await this.clients.updateTemplate(this.allowed(req, 'edit').orgId, tid, dto) };
  }

  @Delete('agreement-templates/:tid')
  async deleteTemplate(@Req() req: any, @Param('tid') tid: string) {
    return { success: true, data: await this.clients.deleteTemplate(this.allowed(req, 'delete').orgId, tid) };
  }

  // ── tickets (admin, org-wide) ──
  @Get('tickets')
  async listTickets(@Req() req: any, @Query('status') status?: string) {
    return { success: true, data: await this.clients.listTickets(this.allowed(req, 'view').orgId, { status }) };
  }

  @Get('tickets/:ticketId')
  async getTicket(@Req() req: any, @Param('ticketId') ticketId: string) {
    return { success: true, data: await this.clients.getTicketAdmin(this.allowed(req, 'view').orgId, ticketId) };
  }

  @Patch('tickets/:ticketId')
  async updateTicket(@Req() req: any, @Param('ticketId') ticketId: string, @Body() dto: UpdateTicketDto) {
    return { success: true, data: await this.clients.updateTicket(this.allowed(req, 'edit').orgId, ticketId, dto) };
  }

  @Post('tickets/:ticketId/messages')
  async staffTicketReply(@Req() req: any, @Param('ticketId') ticketId: string, @Body() dto: TicketMessageDto) {
    return { success: true, data: await this.clients.staffReply(this.allowed(req, 'edit'), ticketId, dto) };
  }

  /** Portal home for a client-role user. */
  @Get('portal/overview')
  async portalOverview(@Req() req: any) {
    const c = this.caller(req);
    return { success: true, data: await this.clients.portalOverview(c.orgId, c.userId) };
  }

  /** Portal: read a board shared with the caller's client (notes + comments). */
  @Get('portal/boards/:boardId')
  async portalBoard(@Req() req: any, @Param('boardId') boardId: string) {
    const c = this.caller(req);
    return { success: true, data: await this.clients.portalBoard(c.orgId, c.userId, boardId) };
  }

  /** Portal: comment on a shared board (needs 'comment' permission). */
  @Post('portal/boards/:boardId/comments')
  async portalComment(@Req() req: any, @Param('boardId') boardId: string, @Body() dto: PortalCommentDto) {
    const c = this.caller(req);
    return { success: true, data: await this.clients.portalComment(c.orgId, c.userId, boardId, dto) };
  }

  /** Portal: the client's vault — what we shared, and what they sent us. */
  @Get('portal/documents')
  async portalDocuments(@Req() req: any) {
    const c = this.caller(req);
    return { success: true, data: await this.clients.portalDocuments(c.orgId, c.userId) };
  }

  /** Portal: the client sends US a document, optionally for us to sign. */
  @Post('portal/documents')
  async portalUploadDocument(@Req() req: any, @Body() dto: PortalUploadDocumentDto) {
    const c = this.caller(req);
    return { success: true, data: await this.clients.portalUploadDocument(c.orgId, c.userId, dto) };
  }

  /** Portal: the client signs a document we asked them to sign. */
  @Post('portal/documents/:docId/sign')
  async portalSignDocument(@Req() req: any, @Param('docId') docId: string, @Body() dto: SignDocumentDto, @Ip() ip: string) {
    const c = this.caller(req);
    return { success: true, data: await this.clients.signDocumentAsClient(c.orgId, c.userId, docId, dto, ip, req.headers?.['user-agent']) };
  }

  // ── portal tickets ──
  @Get('portal/tickets')
  async portalListTickets(@Req() req: any) {
    const c = this.caller(req);
    return { success: true, data: await this.clients.portalListTickets(c.orgId, c.userId) };
  }

  @Post('portal/tickets')
  async portalCreateTicket(@Req() req: any, @Body() dto: CreateTicketDto) {
    const c = this.caller(req);
    return { success: true, data: await this.clients.portalCreateTicket(c.orgId, c.userId, dto) };
  }

  @Get('portal/tickets/:ticketId')
  async portalGetTicket(@Req() req: any, @Param('ticketId') ticketId: string) {
    const c = this.caller(req);
    return { success: true, data: await this.clients.portalGetTicket(c.orgId, c.userId, ticketId) };
  }

  @Post('portal/tickets/:ticketId/messages')
  async portalTicketReply(@Req() req: any, @Param('ticketId') ticketId: string, @Body() dto: TicketMessageDto) {
    const c = this.caller(req);
    return { success: true, data: await this.clients.portalReply(c.orgId, c.userId, ticketId, dto) };
  }

  /** Portal: agreements sent to the caller's client. */
  @Get('portal/agreements')
  async portalAgreements(@Req() req: any) {
    const c = this.caller(req);
    return { success: true, data: await this.clients.portalAgreements(c.orgId, c.userId) };
  }

  /** Portal: read one agreement. */
  @Get('portal/agreements/:agreementId')
  async portalAgreement(@Req() req: any, @Param('agreementId') agreementId: string) {
    const c = this.caller(req);
    return { success: true, data: await this.clients.portalAgreement(c.orgId, c.userId, agreementId) };
  }

  /** Portal: sign an agreement. */
  @Post('portal/agreements/:agreementId/sign')
  async signAgreement(@Req() req: any, @Param('agreementId') agreementId: string, @Body() dto: SignAgreementDto) {
    const c = this.caller(req);
    const ip = req.ip || req.connection?.remoteAddress;
    const ua = req.headers?.['user-agent'];
    return { success: true, data: await this.clients.signAgreement(c.orgId, c.userId, agreementId, dto, ip, ua) };
  }

  // ── clients CRUD ──
  @Post()
  async create(@Req() req: any, @Body() dto: CreateClientDto) {
    return { success: true, data: await this.clients.create(this.allowed(req, 'create'), dto) };
  }

  @Get()
  async list(@Req() req: any, @Query('status') status?: string, @Query('q') q?: string, @Query('tag') tag?: string) {
    // Sales users pick a client when creating a lead, so sales:view may list too.
    return { success: true, data: await this.clients.list(this.allowed(req, 'view', ['sales', 'view']).orgId, { status, q, tag }) };
  }

  @Get(':id')
  async get(@Req() req: any, @Param('id') id: string) {
    return { success: true, data: await this.clients.get(this.allowed(req, 'view').orgId, id) };
  }

  @Patch(':id')
  async update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateClientDto) {
    return { success: true, data: await this.clients.update(this.allowed(req, 'edit'), id, dto) };
  }

  @Post(':id/archive')
  async archive(@Req() req: any, @Param('id') id: string) {
    return { success: true, data: await this.clients.archive(this.allowed(req, 'edit').orgId, id) };
  }

  @Post(':id/restore')
  async restore(@Req() req: any, @Param('id') id: string) {
    return { success: true, data: await this.clients.restore(this.allowed(req, 'edit').orgId, id) };
  }

  @Delete(':id')
  async remove(@Req() req: any, @Param('id') id: string) {
    return { success: true, data: await this.clients.remove(this.allowed(req, 'delete').orgId, id) };
  }

  // ── contacts + portal invite ──
  @Post(':id/contacts')
  async addContact(@Req() req: any, @Param('id') id: string, @Body() dto: CreateContactDto) {
    return { success: true, data: await this.clients.addContact(this.allowed(req, 'create').orgId, id, dto) };
  }

  @Patch(':id/contacts/:contactId')
  async updateContact(@Req() req: any, @Param('id') id: string, @Param('contactId') contactId: string, @Body() dto: UpdateContactDto) {
    return { success: true, data: await this.clients.updateContact(this.allowed(req, 'edit').orgId, id, contactId, dto) };
  }

  @Delete(':id/contacts/:contactId')
  async removeContact(@Req() req: any, @Param('id') id: string, @Param('contactId') contactId: string) {
    return { success: true, data: await this.clients.removeContact(this.allowed(req, 'delete').orgId, id, contactId) };
  }

  @Post(':id/contacts/:contactId/invite')
  async invite(@Req() req: any, @Param('id') id: string, @Param('contactId') contactId: string, @Body() dto: InviteContactDto) {
    return { success: true, data: await this.clients.inviteContact(this.allowed(req, 'edit'), id, contactId, dto) };
  }

  @Post(':id/portal-users/:userId/deactivate')
  async deactivatePortalUser(@Req() req: any, @Param('id') id: string, @Param('userId') userId: string) {
    return { success: true, data: await this.clients.deactivatePortalUser(this.allowed(req, 'edit').orgId, id, userId) };
  }

  // ── assignments ──
  @Post(':id/assignments')
  async assign(@Req() req: any, @Param('id') id: string, @Body() dto: AssignEmployeeDto) {
    return { success: true, data: await this.clients.assignEmployee(this.allowed(req, 'edit'), id, dto) };
  }

  @Delete(':id/assignments/:userId')
  async unassign(@Req() req: any, @Param('id') id: string, @Param('userId') userId: string) {
    return { success: true, data: await this.clients.unassignEmployee(this.allowed(req, 'edit').orgId, id, userId) };
  }

  // ── board sharing ──
  @Post(':id/boards')
  async shareBoard(@Req() req: any, @Param('id') id: string, @Body() dto: ShareBoardDto) {
    return { success: true, data: await this.clients.shareBoard(this.allowed(req, 'edit'), id, dto) };
  }

  @Delete(':id/boards/:boardId')
  async unshareBoard(@Req() req: any, @Param('id') id: string, @Param('boardId') boardId: string) {
    return { success: true, data: await this.clients.unshareBoard(this.allowed(req, 'edit').orgId, id, boardId) };
  }

  // ── agreements (admin) ──
  @Get(':id/agreements')
  async listAgreements(@Req() req: any, @Param('id') id: string) {
    return { success: true, data: await this.clients.listAgreements(this.allowed(req, 'view').orgId, id) };
  }

  @Post(':id/agreements')
  async createAgreement(@Req() req: any, @Param('id') id: string, @Body() dto: CreateAgreementDto) {
    return { success: true, data: await this.clients.createAgreement(this.allowed(req, 'create'), id, dto) };
  }

  @Patch(':id/agreements/:agreementId')
  async updateAgreement(@Req() req: any, @Param('id') id: string, @Param('agreementId') agreementId: string, @Body() dto: UpdateAgreementDto) {
    return { success: true, data: await this.clients.updateAgreement(this.allowed(req, 'edit').orgId, id, agreementId, dto) };
  }

  @Post(':id/agreements/:agreementId/send')
  async sendAgreement(@Req() req: any, @Param('id') id: string, @Param('agreementId') agreementId: string) {
    return { success: true, data: await this.clients.sendAgreement(this.allowed(req, 'edit').orgId, id, agreementId) };
  }

  @Post(':id/agreements/:agreementId/void')
  async voidAgreement(@Req() req: any, @Param('id') id: string, @Param('agreementId') agreementId: string) {
    return { success: true, data: await this.clients.voidAgreement(this.allowed(req, 'edit').orgId, id, agreementId) };
  }

  @Post(':id/agreements/:agreementId/remind')
  async remindAgreement(@Req() req: any, @Param('id') id: string, @Param('agreementId') agreementId: string) {
    return { success: true, data: await this.clients.remindAgreement(this.allowed(req, 'edit').orgId, id, agreementId) };
  }

  @Delete(':id/agreements/:agreementId')
  async deleteAgreement(@Req() req: any, @Param('id') id: string, @Param('agreementId') agreementId: string) {
    return { success: true, data: await this.clients.deleteAgreement(this.allowed(req, 'delete').orgId, id, agreementId) };
  }

  /** The master switch — turning it on invites the client's contacts. */
  @Patch(':id/portal')
  async setPortalEnabled(@Req() req: any, @Param('id') id: string, @Body() dto: SetClientPortalDto) {
    return { success: true, data: await this.clients.setPortalEnabled(this.allowed(req, 'edit'), id, dto.enabled) };
  }

  // ── document vault (admin) ──
  /** Documents clients have sent us that are waiting on our signature. */
  @Get('documents/awaiting-signature')
  async documentsAwaitingUs(@Req() req: any) {
    return { success: true, data: await this.clients.documentsAwaitingUs(this.allowed(req, 'view').orgId) };
  }

  @Get(':id/documents')
  async listDocuments(@Req() req: any, @Param('id') id: string) {
    return { success: true, data: await this.clients.listDocuments(this.allowed(req, 'view').orgId, id) };
  }

  @Post(':id/documents')
  async addDocument(@Req() req: any, @Param('id') id: string, @Body() dto: CreateDocumentDto) {
    return { success: true, data: await this.clients.addDocument(this.allowed(req, 'create'), id, dto) };
  }

  /** Turn the "client must sign this" tick on or off. */
  @Patch(':id/documents/:docId')
  async updateDocument(@Req() req: any, @Param('id') id: string, @Param('docId') docId: string, @Body() dto: UpdateDocumentDto) {
    return { success: true, data: await this.clients.updateDocument(this.allowed(req, 'edit').orgId, id, docId, dto) };
  }

  /** We sign a document the client sent us. */
  @Post(':id/documents/:docId/sign')
  async signDocument(@Req() req: any, @Param('id') id: string, @Param('docId') docId: string, @Body() dto: SignDocumentDto, @Ip() ip: string) {
    const caller = this.allowed(req, 'edit');
    return { success: true, data: await this.clients.signDocumentAsOrg(caller, id, docId, dto, ip, req.headers?.['user-agent']) };
  }

  @Delete(':id/documents/:docId')
  async removeDocument(@Req() req: any, @Param('id') id: string, @Param('docId') docId: string) {
    return { success: true, data: await this.clients.removeDocument(this.allowed(req, 'delete').orgId, id, docId) };
  }

  // ── tickets (admin, per client) ──
  @Get(':id/tickets')
  async listClientTickets(@Req() req: any, @Param('id') id: string) {
    return { success: true, data: await this.clients.listTicketsForClient(this.allowed(req, 'view').orgId, id) };
  }

  @Post(':id/tickets')
  async createClientTicket(@Req() req: any, @Param('id') id: string, @Body() dto: CreateTicketDto) {
    return { success: true, data: await this.clients.createTicketAsStaff(this.allowed(req, 'create'), id, dto) };
  }
}
