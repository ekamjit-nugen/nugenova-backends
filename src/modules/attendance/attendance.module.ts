import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { PolicyModule } from '../policy/policy.module';
import { NotificationModule } from '../notification/notification.module';
import { AttendanceEntity } from './entities/attendance.entity';
import { HolidayEntity } from './entities/holiday.entity';
import { WfhRequestEntity } from './entities/wfh-request.entity';
import { OrganizationEntity } from '../organization/entities/organization.entity';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { UserEntity } from '../auth/entities/user.entity';

import { AttendanceService } from './services/attendance.service';
import { WfhRequestService } from './services/wfh-request.service';
import { AttendanceAccessGuard } from './guards/attendance-access.guard';
import { AttendanceController } from './attendance.controller';

/**
 * Attendance — the interactive time-tracking surface (Phase 1): clock in/out,
 * today/my/stats, org roster + activity feed, manual-entry + edit-request
 * review, and holidays. Org-scoped and permission-gated via
 * AttendanceAccessGuard (see PLAYBOOK.md). TermsService is global (consent gate).
 *
 * Registers the shared auth/org entities it reads (User for names, OrgMembership
 * for the roster/department filter, Organization for the lifecycle gate).
 */
@Module({
  imports: [
    AuthModule,
    PolicyModule,
    NotificationModule,
    TypeOrmModule.forFeature([
      AttendanceEntity,
      HolidayEntity,
      WfhRequestEntity,
      OrganizationEntity,
      OrgMembershipEntity,
      UserEntity,
    ]),
  ],
  controllers: [AttendanceController],
  providers: [AttendanceService, WfhRequestService, AttendanceAccessGuard],
  exports: [AttendanceService],
})
export class AttendanceModule {}
