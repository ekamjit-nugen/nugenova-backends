import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PolicyAccessGuard } from './guards/policy-access.guard';
import { RequirePermission } from '../organization/guards/require-permission.decorator';
import { PolicyService } from './policy.service';
import { IsBoolean } from 'class-validator';
import {
  AcknowledgePolicyDto,
  CreateFromTemplateDto,
  CreatePolicyDto,
  PolicyQueryDto,
  UpdatePolicyDto,
} from './dto';

class SetActiveDto {
  @IsBoolean() isActive: boolean;
}

/**
 * Policies — the org rulebook. Reads (list / view / applicable / acknowledge)
 * are open to any org member; authoring (create / edit / delete / from-template)
 * needs `policies:*`. Every route resolves the org from the JWT. Base: `/api/v1`.
 */
@Controller('policies')
@UseGuards(JwtAuthGuard, PolicyAccessGuard)
export class PolicyController {
  constructor(private readonly policies: PolicyService) {}

  private orgId(req: any): string {
    const id = req.user?.organizationId;
    if (!id) throw new Error('No organization context');
    return id;
  }

  // ── authoring (policies:*) ───────────────────────────────────────────────────

  @Post()
  @RequirePermission('policies', 'create')
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreatePolicyDto, @Req() req: any) {
    const data = await this.policies.create(this.orgId(req), dto, req.user.userId);
    return { success: true, data };
  }

  /** The static work-timing/location/WFH templates an author can clone. */
  @Get('templates')
  @RequirePermission('policies', 'create')
  async templates() {
    return { success: true, data: this.policies.listTemplates() };
  }

  @Post('from-template/:templateName')
  @RequirePermission('policies', 'create')
  @HttpCode(HttpStatus.CREATED)
  async fromTemplate(
    @Param('templateName') templateName: string,
    @Body() dto: CreateFromTemplateDto,
    @Req() req: any,
  ) {
    const data = await this.policies.createFromTemplate(
      this.orgId(req),
      decodeURIComponent(templateName),
      dto,
      req.user.userId,
    );
    return { success: true, data };
  }

  // ── reads (any member) ───────────────────────────────────────────────────────

  /** Policies applying to the caller (their read/acknowledge list). */
  @Get('applicable')
  async applicable(@Req() req: any) {
    const data = await this.policies.listApplicable(this.orgId(req), req.user.userId);
    return { success: true, data };
  }

  /** Owner/admin dashboard summary: policy counts + outstanding acknowledgements. */
  @Get('summary')
  @RequirePermission('policies', 'view')
  async summary(@Req() req: any) {
    const data = await this.policies.getOwnerSummary(this.orgId(req));
    return { success: true, data };
  }

  @Get('my-acknowledgements')
  async myAcks(@Req() req: any) {
    const data = await this.policies.myAcknowledgements(this.orgId(req), req.user.userId);
    return { success: true, data };
  }

  /**
   * The policies the caller must accept before using the platform (the login
   * acceptance gate reads this). Empty ⇒ nothing outstanding.
   */
  @Get('pending-acknowledgements')
  async pendingAcks(@Req() req: any) {
    const data = await this.policies.pendingAcknowledgements(this.orgId(req), req.user.userId);
    return { success: true, data };
  }

  @Get()
  async list(@Query() q: PolicyQueryDto, @Req() req: any) {
    const data = await this.policies.list(this.orgId(req), q);
    return { success: true, data };
  }

  @Get(':id')
  async get(@Param('id') id: string, @Req() req: any) {
    const data = await this.policies.get(this.orgId(req), id);
    return { success: true, data };
  }

  /** Version history (any member may read the audit trail of a policy). */
  @Get(':id/versions')
  async versions(@Param('id') id: string, @Req() req: any) {
    const data = await this.policies.getVersionHistory(this.orgId(req), id);
    return { success: true, data };
  }

  /** Who must acknowledge vs who has (owner/manager compliance view). */
  @Get(':id/acknowledgements')
  @RequirePermission('policies', 'view')
  async acknowledgements(@Param('id') id: string, @Req() req: any) {
    const data = await this.policies.getAcknowledgementStatus(this.orgId(req), id);
    return { success: true, data };
  }

  @Post(':id/acknowledge')
  @HttpCode(HttpStatus.OK)
  async acknowledge(
    @Param('id') id: string,
    @Body() dto: AcknowledgePolicyDto,
    @Req() req: any,
  ) {
    const data = await this.policies.acknowledge(
      this.orgId(req),
      id,
      req.user.userId,
      dto.version,
    );
    return { success: true, message: 'Policy acknowledged', data };
  }

  // ── authoring writes on an existing policy ───────────────────────────────────

  @Put(':id')
  @RequirePermission('policies', 'edit')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdatePolicyDto,
    @Req() req: any,
  ) {
    const data = await this.policies.update(this.orgId(req), id, dto, req.user.userId);
    return { success: true, data };
  }

  /** Activate / deactivate a policy (the list toggle) — no version bump. */
  @Put(':id/active')
  @RequirePermission('policies', 'edit')
  async setActive(
    @Param('id') id: string,
    @Body() dto: SetActiveDto,
    @Req() req: any,
  ) {
    const data = await this.policies.setActive(
      this.orgId(req),
      id,
      dto.isActive,
      req.user.userId,
    );
    return { success: true, data };
  }

  @Delete(':id')
  @RequirePermission('policies', 'delete')
  async remove(@Param('id') id: string, @Req() req: any) {
    await this.policies.remove(this.orgId(req), id);
    return { success: true, message: 'Policy removed' };
  }
}
