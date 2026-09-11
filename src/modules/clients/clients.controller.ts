import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ClientsCaller, ClientsService } from './clients.service';
import {
  AssignEmployeeDto, CreateClientDto, CreateContactDto, InviteContactDto, ShareBoardDto, UpdateClientDto, UpdateContactDto,
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

  /** Portal home for a client-role user. */
  @Get('portal/overview')
  async portalOverview(@Req() req: any) {
    const c = this.caller(req);
    return { success: true, data: await this.clients.portalOverview(c.orgId, c.userId) };
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
}
