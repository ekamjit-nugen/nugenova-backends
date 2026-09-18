import { Body, Controller, Delete, ForbiddenException, Get, Ip, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { VendorPortalService } from './vendor-portal.service';
import { CreateVendorEmployeeDto, PortalSignAgreementDto, SignVendorDocumentDto, UpdateVendorEmployeeDto } from './dto';

/**
 * The vendor's own portal — `/api/v1/vendor-portal`, for `role='vendor'` logins.
 *
 * Its own path, not `vendors/portal/*`, so these routes can never be shadowed by
 * the staff controller's `:id` routes. Nothing here takes a vendor id: the
 * caller's membership decides what they can see, so there is no id to tamper
 * with. No `vendors` permission is involved — a vendor user holds none.
 */
@Controller('vendor-portal')
@UseGuards(JwtAuthGuard)
export class VendorPortalController {
  constructor(private readonly portal: VendorPortalService) {}

  private caller(req: any): { userId: string; orgId: string } {
    const orgId = req.user?.organizationId;
    const userId = req.user?.userId;
    if (!orgId || !userId) throw new ForbiddenException('No organization context');
    return { userId, orgId };
  }

  /** Portal home: who they are to us, what we still need signed, what we owe. */
  @Get('me')
  async me(@Req() req: any) {
    const c = this.caller(req);
    return { success: true, data: await this.portal.overview(c.orgId, c.userId) };
  }

  @Get('agreements')
  async agreements(@Req() req: any) {
    const c = this.caller(req);
    return { success: true, data: await this.portal.agreementsForCaller(c.orgId, c.userId) };
  }

  /** The vendor signs an agreement we sent them. */
  @Post('agreements/:agreementId/sign')
  async sign(@Req() req: any, @Param('agreementId') agreementId: string, @Body() dto: PortalSignAgreementDto, @Ip() ip: string) {
    const c = this.caller(req);
    return { success: true, data: await this.portal.signAgreement(c.orgId, c.userId, agreementId, dto, ip, req.headers?.['user-agent']) };
  }

  @Get('bills')
  async bills(@Req() req: any) {
    const c = this.caller(req);
    return { success: true, data: await this.portal.billsForCaller(c.orgId, c.userId) };
  }

  /**
   * Documents we shared with them. Read-only in one direction on purpose: a
   * vendor has no upload, so nothing arrives from their side.
   */
  @Get('documents')
  async documents(@Req() req: any) {
    const c = this.caller(req);
    return { success: true, data: await this.portal.documentsForCaller(c.orgId, c.userId) };
  }

  /** They sign a document we asked them to sign. */
  @Post('documents/:docId/sign')
  async signDocument(@Req() req: any, @Param('docId') docId: string, @Body() dto: SignVendorDocumentDto, @Ip() ip: string) {
    const c = this.caller(req);
    return { success: true, data: await this.portal.signDocument(c.orgId, c.userId, docId, dto, ip, req.headers?.['user-agent']) };
  }

  // ── their roster ──
  @Get('people')
  async people(@Req() req: any) {
    const c = this.caller(req);
    return { success: true, data: await this.portal.peopleForCaller(c.orgId, c.userId) };
  }

  @Post('people')
  async addPerson(@Req() req: any, @Body() dto: CreateVendorEmployeeDto) {
    const c = this.caller(req);
    return { success: true, data: await this.portal.addPerson(c.orgId, c.userId, dto) };
  }

  @Patch('people/:employeeId')
  async updatePerson(@Req() req: any, @Param('employeeId') employeeId: string, @Body() dto: UpdateVendorEmployeeDto) {
    const c = this.caller(req);
    return { success: true, data: await this.portal.updatePerson(c.orgId, c.userId, employeeId, dto) };
  }

  @Delete('people/:employeeId')
  async removePerson(@Req() req: any, @Param('employeeId') employeeId: string) {
    const c = this.caller(req);
    return { success: true, data: await this.portal.removePerson(c.orgId, c.userId, employeeId) };
  }
}
