import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { AttendanceModule } from '../attendance/attendance.module';
import { PolicyModule } from '../policy/policy.module';
import { NotificationModule } from '../notification/notification.module';
import { AttendanceAccessGuard } from '../attendance/guards/attendance-access.guard';
import { OrganizationEntity } from '../organization/entities/organization.entity';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { UserEntity } from '../auth/entities/user.entity';

import { TimesheetEntity } from './entities/timesheet.entity';
import { TimesheetService } from './timesheet.service';
import { TimesheetController } from './timesheet.controller';

/**
 * Timesheets — employees log time (pre-filled from attendance) and submit a
 * weekly or monthly timesheet per the org's timesheet policy; managers approve.
 * Reuses AttendanceAccessGuard (self-service vs `attendance:*` manager surface).
 */
@Module({
  imports: [
    AuthModule,
    AttendanceModule,
    PolicyModule,
    NotificationModule,
    TypeOrmModule.forFeature([TimesheetEntity, OrganizationEntity, OrgMembershipEntity, UserEntity]),
  ],
  controllers: [TimesheetController],
  providers: [TimesheetService, AttendanceAccessGuard],
  exports: [TimesheetService],
})
export class TimesheetModule {}
