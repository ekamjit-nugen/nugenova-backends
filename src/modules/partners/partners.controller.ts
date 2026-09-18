import { Body, Controller, ForbiddenException, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { permMapAllows } from '../organization/guards/require-permission.decorator';
import { PartnersCaller, PartnersService } from './partners.service';
import { CreatePartnerDto, UpdatePartnerDto } from './dto';

/**
 * Partners — `/api/v1/partners`, the combined view of clients and vendors.
 *
 * Permissions follow the category rather than inventing a new resource: a client
 * row needs `clients:<action>`, a vendor row needs `vendors:<action>`. Listing
 * needs only one of the two — you see the side you are allowed to see.
 */
type PartnersAction = 'view' | 'create' | 'edit' | 'delete';

@Controller('partners')
@UseGuards(JwtAuthGuard)
export class PartnersController {
  constructor(private readonly partners: PartnersService) {}

  private caller(req: any): PartnersCaller {
    const orgId = req.user?.organizationId;
    if (!orgId) throw new ForbiddenException('No organization context');
    return { userId: req.user?.userId, orgId, isAdmin: req.user?.orgRole === 'owner' || req.user?.orgRole === 'admin' };
  }

  /** The caller, if they may `action` this category of partner. */
  private allowed(req: any, action: PartnersAction, category?: string): PartnersCaller {
    const c = this.caller(req);
    if (c.isAdmin) return c;
    const perms = req.user?.perms;
    const resources = category === 'client' ? ['clients'] : category === 'vendor' ? ['vendors'] : ['clients', 'vendors'];
    if (resources.some((r) => permMapAllows(perms, r, action))) return c;
    throw new ForbiddenException(`You don't have permission to ${action} ${category ?? 'partners'}`);
  }

  @Get()
  async list(
    @Req() req: any,
    @Query('category') category?: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('tag') tag?: string,
  ) {
    const caller = this.allowed(req, 'view', category);
    const rows = await this.partners.list(caller.orgId, { category, status, q, tag });
    // Without a category filter, a role granted only one side sees only that side.
    const perms = req.user?.perms;
    const visible = caller.isAdmin
      ? rows
      : rows.filter((p) => permMapAllows(perms, p.category === 'client' ? 'clients' : 'vendors', 'view'));
    return { success: true, data: visible };
  }

  @Get('stats')
  async stats(@Req() req: any) {
    return { success: true, data: await this.partners.stats(this.allowed(req, 'view').orgId) };
  }

  @Get(':id')
  async get(@Req() req: any, @Param('id') id: string) {
    const caller = this.allowed(req, 'view');
    const partner = await this.partners.get(caller.orgId, id);
    this.allowed(req, 'view', partner.category);
    return { success: true, data: partner };
  }

  @Post()
  async create(@Req() req: any, @Body() dto: CreatePartnerDto) {
    return { success: true, data: await this.partners.create(this.allowed(req, 'create', dto.category), dto) };
  }

  @Patch(':id')
  async update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdatePartnerDto) {
    const caller = this.allowed(req, 'edit');
    const partner = await this.partners.get(caller.orgId, id);
    return { success: true, data: await this.partners.update(this.allowed(req, 'edit', partner.category), id, dto) };
  }
}
