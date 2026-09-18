import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { permMapAllows } from '../organization/guards/require-permission.decorator';
import { VendorsCaller, VendorsService } from './vendors.service';
import {
  CreateVendorContactDto, CreateVendorDto, CreateVendorEmployeeDto,
  UpdateVendorContactDto, UpdateVendorDto, UpdateVendorEmployeeDto,
} from './dto';

/**
 * Vendors — `/api/v1/vendors`. JWT-guarded and org-scoped. Every route needs the
 * matching `vendors` permission (view / create / edit / delete): owners and
 * admins hold all of them from their tier, custom roles get what the Roles page
 * grants. Rates are commercial terms, so nothing here is readable without
 * `vendors:view` — there is no self-service surface as there is for attendance.
 *
 * NOTE: like Clients, the `@RequireModule('vendors')` gate lands once
 * ModuleEnabledGuard is applied across the delivery modules.
 */
type VendorsAction = 'view' | 'create' | 'edit' | 'delete';

@Controller('vendors')
@UseGuards(JwtAuthGuard)
export class VendorsController {
  constructor(private readonly vendors: VendorsService) {}

  private caller(req: any): VendorsCaller {
    const orgId = req.user?.organizationId;
    if (!orgId) throw new ForbiddenException('No organization context');
    return { userId: req.user?.userId, orgId, isAdmin: req.user?.orgRole === 'owner' || req.user?.orgRole === 'admin' };
  }

  /** The caller, if they may `action` vendors: owner/admin, or a role granted vendors:<action>. */
  private allowed(req: any, action: VendorsAction): VendorsCaller {
    const c = this.caller(req);
    if (c.isAdmin) return c;
    if (permMapAllows(req.user?.perms, 'vendors', action)) return c;
    throw new ForbiddenException(`You don't have permission to ${action} vendors`);
  }

  // ── static routes first (before :id) ──
  @Get('stats')
  async stats(@Req() req: any) {
    return { success: true, data: await this.vendors.stats(this.allowed(req, 'view').orgId) };
  }

  @Get('categories')
  async categories(@Req() req: any) {
    return { success: true, data: await this.vendors.categories(this.allowed(req, 'view').orgId) };
  }

  // ── vendors ──
  @Get()
  async list(
    @Req() req: any,
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('category') category?: string,
    @Query('tag') tag?: string,
  ) {
    return { success: true, data: await this.vendors.list(this.allowed(req, 'view').orgId, { status, q, category, tag }) };
  }

  @Post()
  async create(@Req() req: any, @Body() dto: CreateVendorDto) {
    return { success: true, data: await this.vendors.create(this.allowed(req, 'create'), dto) };
  }

  @Get(':id')
  async get(@Req() req: any, @Param('id') id: string) {
    return { success: true, data: await this.vendors.get(this.allowed(req, 'view').orgId, id) };
  }

  @Patch(':id')
  async update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateVendorDto) {
    return { success: true, data: await this.vendors.update(this.allowed(req, 'edit'), id, dto) };
  }

  @Delete(':id')
  async remove(@Req() req: any, @Param('id') id: string) {
    return { success: true, data: await this.vendors.remove(this.allowed(req, 'delete'), id) };
  }

  // ── contacts ──
  @Post(':id/contacts')
  async addContact(@Req() req: any, @Param('id') id: string, @Body() dto: CreateVendorContactDto) {
    return { success: true, data: await this.vendors.addContact(this.allowed(req, 'create').orgId, id, dto) };
  }

  @Patch(':id/contacts/:contactId')
  async updateContact(@Req() req: any, @Param('id') id: string, @Param('contactId') contactId: string, @Body() dto: UpdateVendorContactDto) {
    return { success: true, data: await this.vendors.updateContact(this.allowed(req, 'edit').orgId, id, contactId, dto) };
  }

  @Delete(':id/contacts/:contactId')
  async removeContact(@Req() req: any, @Param('id') id: string, @Param('contactId') contactId: string) {
    return { success: true, data: await this.vendors.removeContact(this.allowed(req, 'delete').orgId, id, contactId) };
  }

  // ── vendor employees (the contractors they supply) ──
  @Get(':id/employees')
  async listEmployees(
    @Req() req: any,
    @Param('id') id: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('skill') skill?: string,
  ) {
    return { success: true, data: await this.vendors.listEmployees(this.allowed(req, 'view').orgId, id, { status, q, skill }) };
  }

  @Post(':id/employees')
  async addEmployee(@Req() req: any, @Param('id') id: string, @Body() dto: CreateVendorEmployeeDto) {
    return { success: true, data: await this.vendors.addEmployee(this.allowed(req, 'create').orgId, id, dto) };
  }

  @Patch(':id/employees/:employeeId')
  async updateEmployee(@Req() req: any, @Param('id') id: string, @Param('employeeId') employeeId: string, @Body() dto: UpdateVendorEmployeeDto) {
    return { success: true, data: await this.vendors.updateEmployee(this.allowed(req, 'edit').orgId, id, employeeId, dto) };
  }

  @Delete(':id/employees/:employeeId')
  async removeEmployee(@Req() req: any, @Param('id') id: string, @Param('employeeId') employeeId: string) {
    return { success: true, data: await this.vendors.removeEmployee(this.allowed(req, 'delete').orgId, id, employeeId) };
  }
}
