import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { VerticalModule } from '../vertical/vertical.module';
import { HolidayEntity } from '../attendance/entities/holiday.entity';
import { LeaveRequestEntity } from '../leave/entities/leave-request.entity';
import { MeetingEntity } from '../meetings/entities/meeting.entity';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { UserEntity } from '../auth/entities/user.entity';

import { CalendarService } from './calendar.service';
import { CalendarController } from './calendar.controller';

/**
 * Calendar — a read-only aggregator over holidays, leave, meetings and
 * birthdays. Gated on the `calendar` module (VerticalModule provides the guard).
 */
@Module({
  imports: [
    AuthModule,
    VerticalModule,
    TypeOrmModule.forFeature([HolidayEntity, LeaveRequestEntity, MeetingEntity, OrgMembershipEntity, UserEntity]),
  ],
  controllers: [CalendarController],
  providers: [CalendarService],
  exports: [CalendarService],
})
export class CalendarModule {}
