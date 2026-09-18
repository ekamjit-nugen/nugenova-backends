import { Body, Controller, Delete, ForbiddenException, Get, Ip, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { permMapAllows } from '../organization/guards/require-permission.decorator';
import { VendorsCaller, VendorsService } from './vendors.service';
import { VendorAgreementsService } from './vendor-agreements.service';
import { VendorBillsService } from './vendor-bills.service';
import { VendorPortalService } from './vendor-portal.service';
import { VendorDocumentsService } from './vendor-documents.service';
import {
  CancelVendorBillDto, CreateVendorAgreementDto, CreateVendorAgreementTemplateDto, CreateVendorBillDto,
  CreateVendorDocumentDto, SignVendorDocumentDto, UpdateVendorDocumentDto,
  CreateVendorContactDto, CreateVendorDto, CreateVendorEmployeeDto, DeclineVendorAgreementDto,
  InviteVendorContactDto, MarkVendorBillPaidDto, SetPortalEnabledDto, SignVendorAgreementDto, UpdateVendorAgreementDto, UpdateVendorAgreementTemplateDto,
  UpdateVendorBillDto, UpdateVendorContactDto, UpdateVendorDto, UpdateVendorEmployeeDto,
  WaiveVendorAgreementDto,
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
  constructor(
    private readonly vendors: VendorsService,
    private readonly agreements: VendorAgreementsService,
    private readonly billing: VendorBillsService,
    private readonly portal: VendorPortalService,
    private readonly documents: VendorDocumentsService,
  ) {}

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

  // ── bills across the org (the payables queue) ──
  @Get('bills')
  async listBills(
    @Req() req: any,
    @Query('status') status?: string,
    @Query('vendorId') vendorId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return { success: true, data: await this.billing.listForOrg(this.allowed(req, 'view').orgId, { status, vendorId, from, to }) };
  }

  @Get('bills/:billId')
  async getBill(@Req() req: any, @Param('billId') billId: string) {
    return { success: true, data: await this.billing.get(this.allowed(req, 'view').orgId, billId) };
  }

  @Patch('bills/:billId')
  async updateBill(@Req() req: any, @Param('billId') billId: string, @Body() dto: UpdateVendorBillDto) {
    return { success: true, data: await this.billing.update(this.allowed(req, 'edit').orgId, billId, dto) };
  }

  /** Agree the bill — it becomes what we owe. */
  @Post('bills/:billId/approve')
  async approveBill(@Req() req: any, @Param('billId') billId: string) {
    return { success: true, data: await this.billing.approve(this.allowed(req, 'edit'), billId) };
  }

  /** Record that we paid it; the money moves elsewhere. */
  @Post('bills/:billId/mark-paid')
  async markBillPaid(@Req() req: any, @Param('billId') billId: string, @Body() dto: MarkVendorBillPaidDto) {
    return { success: true, data: await this.billing.markPaid(this.allowed(req, 'edit'), billId, dto) };
  }

  @Post('bills/:billId/cancel')
  async cancelBill(@Req() req: any, @Param('billId') billId: string, @Body() dto: CancelVendorBillDto) {
    return { success: true, data: await this.billing.cancel(this.allowed(req, 'edit').orgId, billId, dto) };
  }

  @Delete('bills/:billId')
  async deleteBill(@Req() req: any, @Param('billId') billId: string) {
    return { success: true, data: await this.billing.remove(this.allowed(req, 'delete').orgId, billId) };
  }

  // ── agreement templates (org-level, before the :id routes) ──
  @Get('agreement-templates')
  async listTemplates(@Req() req: any, @Query('includeArchived') includeArchived?: string) {
    return { success: true, data: await this.agreements.listTemplates(this.allowed(req, 'view').orgId, includeArchived === 'true') };
  }

  @Post('agreement-templates')
  async createTemplate(@Req() req: any, @Body() dto: CreateVendorAgreementTemplateDto) {
    return { success: true, data: await this.agreements.createTemplate(this.allowed(req, 'create'), dto) };
  }

  @Patch('agreement-templates/:templateId')
  async updateTemplate(@Req() req: any, @Param('templateId') templateId: string, @Body() dto: UpdateVendorAgreementTemplateDto) {
    return { success: true, data: await this.agreements.updateTemplate(this.allowed(req, 'edit').orgId, templateId, dto) };
  }

  @Delete('agreement-templates/:templateId')
  async deleteTemplate(@Req() req: any, @Param('templateId') templateId: string) {
    return { success: true, data: await this.agreements.deleteTemplate(this.allowed(req, 'delete').orgId, templateId) };
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

  // ── portal access for a vendor's contacts ──
  @Get(':id/portal-users')
  async portalUsers(@Req() req: any, @Param('id') id: string) {
    return { success: true, data: await this.portal.portalUsers(this.allowed(req, 'view').orgId, id) };
  }

  /** The master switch — turning it on invites the vendor's contacts. */
  @Patch(':id/portal')
  async setPortalEnabled(@Req() req: any, @Param('id') id: string, @Body() dto: SetPortalEnabledDto) {
    return { success: true, data: await this.portal.setPortalEnabled(this.allowed(req, 'edit'), id, dto.enabled) };
  }

  /** Give a contact a login to the vendor portal. */
  @Post(':id/contacts/:contactId/invite')
  async invitePortalUser(@Req() req: any, @Param('id') id: string, @Param('contactId') contactId: string, @Body() dto: InviteVendorContactDto) {
    return { success: true, data: await this.portal.invite(this.allowed(req, 'create'), id, contactId, dto) };
  }

  /** Take that login away again, keeping the contact record. */
  @Delete(':id/contacts/:contactId/invite')
  async revokePortalUser(@Req() req: any, @Param('id') id: string, @Param('contactId') contactId: string) {
    return { success: true, data: await this.portal.revoke(this.allowed(req, 'edit').orgId, id, contactId) };
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

  /** Make a supplied person a secondary member of the org. */
  @Post(':id/employees/:employeeId/promote')
  async promoteEmployee(@Req() req: any, @Param('id') id: string, @Param('employeeId') employeeId: string) {
    return { success: true, data: await this.vendors.promoteEmployee(this.allowed(req, 'edit'), id, employeeId) };
  }

  /** Take them back out of the org; their record at the vendor stays. */
  @Delete(':id/employees/:employeeId/promote')
  async demoteEmployee(@Req() req: any, @Param('id') id: string, @Param('employeeId') employeeId: string) {
    return { success: true, data: await this.vendors.demoteEmployee(this.allowed(req, 'edit').orgId, id, employeeId) };
  }

  @Patch(':id/employees/:employeeId')
  async updateEmployee(@Req() req: any, @Param('id') id: string, @Param('employeeId') employeeId: string, @Body() dto: UpdateVendorEmployeeDto) {
    return { success: true, data: await this.vendors.updateEmployee(this.allowed(req, 'edit').orgId, id, employeeId, dto) };
  }

  @Delete(':id/employees/:employeeId')
  async removeEmployee(@Req() req: any, @Param('id') id: string, @Param('employeeId') employeeId: string) {
    return { success: true, data: await this.vendors.removeEmployee(this.allowed(req, 'delete').orgId, id, employeeId) };
  }

  // ── agreements for one vendor ──
  @Get(':id/agreements')
  async listAgreements(@Req() req: any, @Param('id') id: string) {
    return { success: true, data: await this.agreements.list(this.allowed(req, 'view').orgId, id) };
  }

  /** Is this vendor cleared to supply people, and what is outstanding? */
  @Get(':id/clearance')
  async clearance(@Req() req: any, @Param('id') id: string) {
    return { success: true, data: await this.agreements.clearance(this.allowed(req, 'view').orgId, id) };
  }

  @Post(':id/agreements')
  async createAgreement(@Req() req: any, @Param('id') id: string, @Body() dto: CreateVendorAgreementDto) {
    return { success: true, data: await this.agreements.create(this.allowed(req, 'create'), id, dto) };
  }

  /** Raise every required agreement this vendor is missing, in one go. */
  @Post(':id/agreements/issue-required')
  async issueRequired(@Req() req: any, @Param('id') id: string) {
    return { success: true, data: await this.agreements.issueRequired(this.allowed(req, 'create'), id) };
  }

  @Patch(':id/agreements/:agreementId')
  async updateAgreement(@Req() req: any, @Param('id') id: string, @Param('agreementId') agreementId: string, @Body() dto: UpdateVendorAgreementDto) {
    return { success: true, data: await this.agreements.update(this.allowed(req, 'edit').orgId, id, agreementId, dto) };
  }

  @Post(':id/agreements/:agreementId/send')
  async sendAgreement(@Req() req: any, @Param('id') id: string, @Param('agreementId') agreementId: string) {
    return { success: true, data: await this.agreements.send(this.allowed(req, 'edit').orgId, id, agreementId) };
  }

  /** Record the signature the vendor gave us (in the app, or on paper). */
  @Post(':id/agreements/:agreementId/sign')
  async signAgreement(
    @Req() req: any,
    @Param('id') id: string,
    @Param('agreementId') agreementId: string,
    @Body() dto: SignVendorAgreementDto,
    @Ip() ip: string,
  ) {
    const caller = this.allowed(req, 'edit');
    return { success: true, data: await this.agreements.sign(caller, id, agreementId, dto, ip, req.headers?.['user-agent']) };
  }

  @Post(':id/agreements/:agreementId/decline')
  async declineAgreement(@Req() req: any, @Param('id') id: string, @Param('agreementId') agreementId: string, @Body() dto: DeclineVendorAgreementDto) {
    return { success: true, data: await this.agreements.decline(this.allowed(req, 'edit').orgId, id, agreementId, dto) };
  }

  /** Clear the vendor without this signature — the reason is recorded. */
  @Post(':id/agreements/:agreementId/waive')
  async waiveAgreement(@Req() req: any, @Param('id') id: string, @Param('agreementId') agreementId: string, @Body() dto: WaiveVendorAgreementDto) {
    return { success: true, data: await this.agreements.waive(this.allowed(req, 'edit'), id, agreementId, dto) };
  }

  /** Put a waived agreement back on the checklist. */
  @Delete(':id/agreements/:agreementId/waive')
  async unwaiveAgreement(@Req() req: any, @Param('id') id: string, @Param('agreementId') agreementId: string) {
    return { success: true, data: await this.agreements.unwaive(this.allowed(req, 'edit').orgId, id, agreementId) };
  }

  @Post(':id/agreements/:agreementId/void')
  async voidAgreement(@Req() req: any, @Param('id') id: string, @Param('agreementId') agreementId: string) {
    return { success: true, data: await this.agreements.void(this.allowed(req, 'edit').orgId, id, agreementId) };
  }

  @Delete(':id/agreements/:agreementId')
  async deleteAgreement(@Req() req: any, @Param('id') id: string, @Param('agreementId') agreementId: string) {
    return { success: true, data: await this.agreements.remove(this.allowed(req, 'delete').orgId, id, agreementId) };
  }

  // ── bills for one vendor ──
  @Get(':id/bills')
  async vendorBills(@Req() req: any, @Param('id') id: string) {
    return { success: true, data: await this.billing.listForVendor(this.allowed(req, 'view').orgId, id) };
  }

  /** What this vendor has cost us, by state. */
  @Get(':id/cost-summary')
  async costSummary(@Req() req: any, @Param('id') id: string) {
    return { success: true, data: await this.billing.costSummary(this.allowed(req, 'view').orgId, id) };
  }

  @Post(':id/bills')
  async createBill(@Req() req: any, @Param('id') id: string, @Body() dto: CreateVendorBillDto) {
    return { success: true, data: await this.billing.create(this.allowed(req, 'create'), id, dto) };
  }

  // ── documents we share with a vendor ──
  @Get(':id/documents')
  async listDocuments(@Req() req: any, @Param('id') id: string) {
    return { success: true, data: await this.documents.list(this.allowed(req, 'view').orgId, id) };
  }

  /** Share a file with the vendor; tick `signatureRequired` to ask them to sign. */
  @Post(':id/documents')
  async shareDocument(@Req() req: any, @Param('id') id: string, @Body() dto: CreateVendorDocumentDto) {
    return { success: true, data: await this.documents.share(this.allowed(req, 'create'), id, dto) };
  }

  @Patch(':id/documents/:docId')
  async updateDocument(@Req() req: any, @Param('id') id: string, @Param('docId') docId: string, @Body() dto: UpdateVendorDocumentDto) {
    return { success: true, data: await this.documents.update(this.allowed(req, 'edit').orgId, id, docId, dto) };
  }

  @Delete(':id/documents/:docId')
  async removeDocument(@Req() req: any, @Param('id') id: string, @Param('docId') docId: string) {
    return { success: true, data: await this.documents.remove(this.allowed(req, 'delete').orgId, id, docId) };
  }
}
