import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { OrganizationEntity } from '../organization/entities/organization.entity';
import { DepartmentEntity } from '../organization/entities/department.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { PolicyEntity } from '../policy/entities/policy.entity';
import { AttendanceEntity } from '../attendance/entities/attendance.entity';
import { WfhRequestEntity } from '../attendance/entities/wfh-request.entity';
import { MemberOnboardingEntity } from '../onboarding/entities/member-onboarding.entity';
import { NotificationEntity } from '../notification/entities/notification.entity';

import { AdminPlatformService } from './admin-platform.service';
import { AdminPlatformController } from './admin-platform.controller';

/**
 * Admin platform — the super admin's cross-tenant usage overview. Registers
 * (read-only) every entity it aggregates; AuthModule supplies the JWT +
 * platform-admin guards.
 */
@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([
      OrganizationEntity,
      DepartmentEntity,
      UserEntity,
      OrgMembershipEntity,
      PolicyEntity,
      AttendanceEntity,
      WfhRequestEntity,
      MemberOnboardingEntity,
      NotificationEntity,
    ]),
  ],
  controllers: [AdminPlatformController],
  providers: [AdminPlatformService],
})
export class AdminPlatformModule {}
