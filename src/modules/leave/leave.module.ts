import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { NotificationModule } from '../notification/notification.module';
import { PolicyModule } from '../policy/policy.module';
import { LeaveRequestEntity } from './entities/leave-request.entity';
import { LeaveBalanceEntity } from './entities/leave-balance.entity';
import { HolidayEntity } from '../attendance/entities/holiday.entity';
import { OrganizationEntity } from '../organization/entities/organization.entity';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { UserEntity } from '../auth/entities/user.entity';

import { LeaveService } from './services/leave.service';
import { LeaveAccessGuard } from './guards/leave-access.guard';
import { LeaveController } from './leave.controller';

/**
 * Leave management — apply → manager approve/reject → per-type balances, plus
 * cancel (restores balance). Org-scoped and permission-gated via
 * LeaveAccessGuard (see PLAYBOOK.md). Reuses the holiday calendar (for
 * business-day counting) and the NotifierService (request/decision alerts).
 */
@Module({
  imports: [
    AuthModule,
    NotificationModule,
    PolicyModule,
    TypeOrmModule.forFeature([
      LeaveRequestEntity,
      LeaveBalanceEntity,
      HolidayEntity,
      OrganizationEntity,
      OrgMembershipEntity,
      UserEntity,
    ]),
  ],
  controllers: [LeaveController],
  providers: [LeaveService, LeaveAccessGuard],
  exports: [LeaveService],
})
export class LeaveModule {}
