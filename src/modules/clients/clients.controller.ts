import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ClientsCaller, ClientsService } from './clients.service';
import {
  AssignEmployeeDto, CreateAgreementDto, CreateClientDto, CreateContactDto, CreateDocumentDto, InviteContactDto, PortalCommentDto, ShareBoardDto, SignAgreementDto, UpdateAgreementDto, UpdateClientDto, UpdateContactDto,
} from './dto';

/**
 * Clients — `/api/v1/clients`. JWT-guarded, org-scoped. Management actions are
 * owner/admin only; `mine` and `portal/*` serve assigned employees and client
 * portal users respectively.
 *
 * NOTE: the `clients` module key is registered in vertical-packs; the
 * `@RequireModule('clients')` gate will be added once the ModuleEnabledGuard
 * infra (currently on the meetings/activity branches) merges to main.
 */
@Controller('clients')
@UseGuards(JwtAuthGuard)
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  private caller(req: any): ClientsCaller {
    const orgId = req.user?.organizationId;
    if (!orgId) throw new ForbiddenException('No organization context');
    return { userId: req.user?.userId, orgId, isAdmin: req.user?.orgRole === 'owner' || req.user?.orgRole === 'admin' };
  }
  private requireAdmin(c: ClientsCaller): ClientsCaller {
    if (!c.isAdmin) throw new ForbiddenException('Only an owner or admin can manage clients');
    return c;
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
    return { success: true, data: await this.clients.dashboardSummary(this.requireAdmin(this.caller(req)).orgId) };
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

  /** Portal: documents shared with the caller's client. */
  @Get('portal/documents')
  async portalDocuments(@Req() req: any) {
    const c = this.caller(req);
    return { success: true, data: await this.clients.portalDocuments(c.orgId, c.userId) };
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
    return { success: true, data: await this.clients.create(this.requireAdmin(this.caller(req)), dto) };
  }

  @Get()
  async list(@Req() req: any, @Query('status') status?: string, @Query('q') q?: string, @Query('tag') tag?: string) {
    return { success: true, data: await this.clients.list(this.caller(req).orgId, { status, q, tag }) };
  }

  @Get(':id')
  async get(@Req() req: any, @Param('id') id: string) {
    return { success: true, data: await this.clients.get(this.caller(req).orgId, id) };
  }

  @Patch(':id')
  async update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateClientDto) {
    return { success: true, data: await this.clients.update(this.requireAdmin(this.caller(req)), id, dto) };
  }

  @Post(':id/archive')
  async archive(@Req() req: any, @Param('id') id: string) {
    return { success: true, data: await this.clients.archive(this.requireAdmin(this.caller(req)).orgId, id) };
  }

  @Post(':id/restore')
  async restore(@Req() req: any, @Param('id') id: string) {
    return { success: true, data: await this.clients.restore(this.requireAdmin(this.caller(req)).orgId, id) };
  }

  @Delete(':id')
  async remove(@Req() req: any, @Param('id') id: string) {
    return { success: true, data: await this.clients.remove(this.requireAdmin(this.caller(req)).orgId, id) };
  }

  // ── contacts + portal invite ──
  @Post(':id/contacts')
  async addContact(@Req() req: any, @Param('id') id: string, @Body() dto: CreateContactDto) {
    return { success: true, data: await this.clients.addContact(this.requireAdmin(this.caller(req)).orgId, id, dto) };
  }

  @Patch(':id/contacts/:contactId')
  async updateContact(@Req() req: any, @Param('id') id: string, @Param('contactId') contactId: string, @Body() dto: UpdateContactDto) {
    return { success: true, data: await this.clients.updateContact(this.requireAdmin(this.caller(req)).orgId, id, contactId, dto) };
  }

  @Delete(':id/contacts/:contactId')
  async removeContact(@Req() req: any, @Param('id') id: string, @Param('contactId') contactId: string) {
    return { success: true, data: await this.clients.removeContact(this.requireAdmin(this.caller(req)).orgId, id, contactId) };
  }

  @Post(':id/contacts/:contactId/invite')
  async invite(@Req() req: any, @Param('id') id: string, @Param('contactId') contactId: string, @Body() dto: InviteContactDto) {
    return { success: true, data: await this.clients.inviteContact(this.requireAdmin(this.caller(req)), id, contactId, dto) };
  }

  @Post(':id/portal-users/:userId/deactivate')
  async deactivatePortalUser(@Req() req: any, @Param('id') id: string, @Param('userId') userId: string) {
    return { success: true, data: await this.clients.deactivatePortalUser(this.requireAdmin(this.caller(req)).orgId, id, userId) };
  }

  // ── assignments ──
  @Post(':id/assignments')
  async assign(@Req() req: any, @Param('id') id: string, @Body() dto: AssignEmployeeDto) {
    return { success: true, data: await this.clients.assignEmployee(this.requireAdmin(this.caller(req)), id, dto) };
  }

  @Delete(':id/assignments/:userId')
  async unassign(@Req() req: any, @Param('id') id: string, @Param('userId') userId: string) {
    return { success: true, data: await this.clients.unassignEmployee(this.requireAdmin(this.caller(req)).orgId, id, userId) };
  }

  // ── board sharing ──
  @Post(':id/boards')
  async shareBoard(@Req() req: any, @Param('id') id: string, @Body() dto: ShareBoardDto) {
    return { success: true, data: await this.clients.shareBoard(this.requireAdmin(this.caller(req)), id, dto) };
  }

  @Delete(':id/boards/:boardId')
  async unshareBoard(@Req() req: any, @Param('id') id: string, @Param('boardId') boardId: string) {
    return { success: true, data: await this.clients.unshareBoard(this.requireAdmin(this.caller(req)).orgId, id, boardId) };
  }

  // ── agreements (admin) ──
  @Get(':id/agreements')
  async listAgreements(@Req() req: any, @Param('id') id: string) {
    return { success: true, data: await this.clients.listAgreements(this.requireAdmin(this.caller(req)).orgId, id) };
  }

  @Post(':id/agreements')
  async createAgreement(@Req() req: any, @Param('id') id: string, @Body() dto: CreateAgreementDto) {
    return { success: true, data: await this.clients.createAgreement(this.requireAdmin(this.caller(req)), id, dto) };
  }

  @Patch(':id/agreements/:agreementId')
  async updateAgreement(@Req() req: any, @Param('id') id: string, @Param('agreementId') agreementId: string, @Body() dto: UpdateAgreementDto) {
    return { success: true, data: await this.clients.updateAgreement(this.requireAdmin(this.caller(req)).orgId, id, agreementId, dto) };
  }

  @Post(':id/agreements/:agreementId/send')
  async sendAgreement(@Req() req: any, @Param('id') id: string, @Param('agreementId') agreementId: string) {
    return { success: true, data: await this.clients.sendAgreement(this.requireAdmin(this.caller(req)).orgId, id, agreementId) };
  }

  @Post(':id/agreements/:agreementId/void')
  async voidAgreement(@Req() req: any, @Param('id') id: string, @Param('agreementId') agreementId: string) {
    return { success: true, data: await this.clients.voidAgreement(this.requireAdmin(this.caller(req)).orgId, id, agreementId) };
  }

  @Delete(':id/agreements/:agreementId')
  async deleteAgreement(@Req() req: any, @Param('id') id: string, @Param('agreementId') agreementId: string) {
    return { success: true, data: await this.clients.deleteAgreement(this.requireAdmin(this.caller(req)).orgId, id, agreementId) };
  }

  // ── document vault (admin) ──
  @Get(':id/documents')
  async listDocuments(@Req() req: any, @Param('id') id: string) {
    return { success: true, data: await this.clients.listDocuments(this.requireAdmin(this.caller(req)).orgId, id) };
  }

  @Post(':id/documents')
  async addDocument(@Req() req: any, @Param('id') id: string, @Body() dto: CreateDocumentDto) {
    return { success: true, data: await this.clients.addDocument(this.requireAdmin(this.caller(req)), id, dto) };
  }

  @Delete(':id/documents/:docId')
  async removeDocument(@Req() req: any, @Param('id') id: string, @Param('docId') docId: string) {
    return { success: true, data: await this.clients.removeDocument(this.requireAdmin(this.caller(req)).orgId, id, docId) };
  }
}
