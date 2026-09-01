import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { PolicyModule } from '../policy/policy.module';
import { OrganizationEntity } from './entities/organization.entity';
import { DepartmentEntity } from './entities/department.entity';
import { RoleEntity } from '../auth/entities/role.entity';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { SessionEntity } from '../auth/entities/session.entity';

import { OrganizationService } from './services/organization.service';
import { DepartmentService } from './services/department.service';
import { OrgRoleService } from './services/org-role.service';
import { MembershipService } from './services/membership.service';
import { OrgAdminGuard } from './guards/org-admin.guard';

import { AdminOrganizationController } from './admin-organization.controller';
import { OrgSetupController } from './org-setup.controller';
import { ConsentController } from './consent.controller';
import { AdminTermsController } from './admin-terms.controller';

/**
 * Organization onboarding — the tenant setup spine. Super admins provision orgs
 * (+ their owner); org owners/admins then set up departments, roles and team.
 *
 * Imports AuthModule for the JWT + platform-admin guards, and registers the
 * shared auth entities (User/OrgMembership/Role) it reads/writes alongside its
 * own Organization/Department tables.
 */
@Module({
  imports: [
    AuthModule,
    PolicyModule,
    TypeOrmModule.forFeature([
      OrganizationEntity,
      DepartmentEntity,
      RoleEntity,
      OrgMembershipEntity,
      UserEntity,
      SessionEntity,
    ]),
  ],
  controllers: [
    AdminOrganizationController,
    OrgSetupController,
    ConsentController,
    AdminTermsController,
  ],
  providers: [
    OrganizationService,
    DepartmentService,
    OrgRoleService,
    MembershipService,
    OrgAdminGuard,
  ],
  exports: [OrganizationService],
})
export class OrganizationModule {}
