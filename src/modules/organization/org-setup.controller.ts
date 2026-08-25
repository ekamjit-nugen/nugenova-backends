import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OrgAdminGuard } from './guards/org-admin.guard';
import { RequirePermission } from './guards/require-permission.decorator';
import { DepartmentService } from './services/department.service';
import { OrgRoleService } from './services/org-role.service';
import { MembershipService } from './services/membership.service';
import { OrganizationService } from './services/organization.service';
import {
  AddMemberDto,
  CreateDepartmentDto,
  CreateRoleDto,
  UpdateDepartmentDto,
  UpdateMemberDto,
  UpdateOnboardingDto,
  UpdateOrgProfileDto,
  UpdateRoleDto,
} from './dto';

/**
 * Org-admin setup surface — departments, roles, and team for the org the JWT is
 * scoped to. Every route resolves the acting org from `req.user.organizationId`
 * (never the client), guarded by JWT + OrgAdminGuard (owner/admin only).
 * Effective base path: `/api/v1/org`.
 */
@Controller('org')
@UseGuards(JwtAuthGuard, OrgAdminGuard)
export class OrgSetupController {
  constructor(
    private readonly departments: DepartmentService,
    private readonly roles: OrgRoleService,
    private readonly members: MembershipService,
    private readonly orgs: OrganizationService,
  ) {}

  private orgId(req: any): string {
    // The OrgAdminGuard already guarantees this, but never let a falsy org id
    // reach a repository — TypeORM drops a nullish `where` filter, which would
    // return EVERY org's rows (cross-tenant leak). Fail closed.
    const id = req.user?.organizationId;
    if (!id) throw new ForbiddenException('No organization context');
    return id;
  }

  // ── Setup wizard (org profile + progress) ─────────────────────────────────

  /** The org profile + wizard progress for the owner's setup wizard. */
  @Get('onboarding')
  async onboardingState(@Req() req: any) {
    const data = await this.orgs.getOnboardingState(this.orgId(req));
    return { success: true, data };
  }

  /** Update the org name / merge workspace settings (wizard steps 1–2). */
  @Put('profile')
  async updateProfile(@Body() dto: UpdateOrgProfileDto, @Req() req: any) {
    const data = await this.orgs.updateProfile(this.orgId(req), dto);
    return { success: true, data };
  }

  /** Advance the wizard step / mark it complete. */
  @Put('onboarding')
  async updateOnboarding(@Body() dto: UpdateOnboardingDto, @Req() req: any) {
    const data = await this.orgs.updateOnboarding(this.orgId(req), dto);
    return { success: true, data };
  }

  // ── Departments ─────────────────────────────────────────────────────────────

  @Post('departments')
  @RequirePermission('departments', 'create')
  @HttpCode(HttpStatus.CREATED)
  async createDepartment(@Body() dto: CreateDepartmentDto, @Req() req: any) {
    const data = await this.departments.create(this.orgId(req), dto, req.user.userId);
    return { success: true, data };
  }

  @Get('departments')
  @RequirePermission('departments', 'view')
  async listDepartments(@Req() req: any) {
    const data = await this.departments.list(this.orgId(req));
    return { success: true, data };
  }

  @Put('departments/:id')
  @RequirePermission('departments', 'edit')
  async updateDepartment(
    @Param('id') id: string,
    @Body() dto: UpdateDepartmentDto,
    @Req() req: any,
  ) {
    const data = await this.departments.update(this.orgId(req), id, dto);
    return { success: true, data };
  }

  @Delete('departments/:id')
  @RequirePermission('departments', 'delete')
  async deleteDepartment(@Param('id') id: string, @Req() req: any) {
    await this.departments.remove(this.orgId(req), id);
    return { success: true, message: 'Department removed' };
  }

  // ── Roles ───────────────────────────────────────────────────────────────────

  @Post('roles')
  @RequirePermission('roles', 'create')
  @HttpCode(HttpStatus.CREATED)
  async createRole(@Body() dto: CreateRoleDto, @Req() req: any) {
    const data = await this.roles.create(this.orgId(req), dto, req.user.userId);
    return { success: true, data };
  }

  /**
   * Seed the org's default custom roles (HR, Developer, Designer) — idempotent.
   * Called by the setup wizard's Departments step so the Team step can assign
   * roles out of the box. Returns the org's full role list.
   */
  @Post('roles/seed-defaults')
  @RequirePermission('roles', 'create')
  @HttpCode(HttpStatus.OK)
  async seedDefaultRoles(@Req() req: any) {
    const data = await this.roles.seedDefaults(this.orgId(req), req.user.userId);
    return { success: true, data };
  }

  @Get('roles')
  @RequirePermission('roles', 'view')
  async listRoles(@Req() req: any) {
    const data = await this.roles.list(this.orgId(req));
    return { success: true, data };
  }

  @Put('roles/:id')
  @RequirePermission('roles', 'edit')
  async updateRole(
    @Param('id') id: string,
    @Body() dto: UpdateRoleDto,
    @Req() req: any,
  ) {
    const data = await this.roles.update(this.orgId(req), id, dto);
    return { success: true, data };
  }

  @Delete('roles/:id')
  @RequirePermission('roles', 'delete')
  async deleteRole(@Param('id') id: string, @Req() req: any) {
    await this.roles.remove(this.orgId(req), id);
    return { success: true, message: 'Role removed' };
  }

  // ── Team ────────────────────────────────────────────────────────────────────

  @Post('members')
  @RequirePermission('employees', 'create')
  @HttpCode(HttpStatus.CREATED)
  async addMember(@Body() dto: AddMemberDto, @Req() req: any) {
    const data = await this.members.addMember(this.orgId(req), dto, req.user.userId);
    return { success: true, data };
  }

  @Get('members')
  @RequirePermission('employees', 'view')
  async listMembers(@Req() req: any) {
    const data = await this.members.list(this.orgId(req));
    return { success: true, data };
  }

  @Put('members/:id')
  @RequirePermission('employees', 'edit')
  async updateMember(
    @Param('id') id: string,
    @Body() dto: UpdateMemberDto,
    @Req() req: any,
  ) {
    const data = await this.members.updateMember(this.orgId(req), id, dto);
    return { success: true, data };
  }

  @Delete('members/:id')
  @RequirePermission('employees', 'delete')
  async removeMember(@Param('id') id: string, @Req() req: any) {
    await this.members.removeMember(this.orgId(req), id);
    return { success: true, message: 'Member removed' };
  }

  // ── Overview ────────────────────────────────────────────────────────────────

  @Get('overview')
  async overview(@Req() req: any) {
    const orgId = this.orgId(req);
    const [departments, roles, people] = await Promise.all([
      this.departments.list(orgId),
      this.roles.list(orgId),
      this.members.list(orgId),
    ]);
    return {
      success: true,
      data: {
        organizationId: orgId,
        counts: {
          departments: departments.length,
          roles: roles.length,
          people: people.length,
        },
        departments,
        roles,
        people,
      },
    };
  }
}
