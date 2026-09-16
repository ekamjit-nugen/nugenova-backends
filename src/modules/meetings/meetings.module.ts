import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { NotificationModule } from '../notification/notification.module';
import { VerticalModule } from '../vertical/vertical.module';
import { ActivityModule } from '../activity/activity.module';
import { UserEntity } from '../auth/entities/user.entity';

import { MeetingEntity } from './entities/meeting.entity';
import { MeetingNoticeEntity } from './entities/meeting-notice.entity';
import { MeetingsService } from './meetings.service';
import { MeetingsController } from './meetings.controller';
import { MeetingsCronService } from './meetings-cron.service';

/**
 * Meetings — Jitsi-powered video meetings. Owns scheduling, invites, access
 * control and lifecycle; the A/V room itself is a Jitsi room. Gated on the
 * `meetings` module via {@link ModuleEnabledGuard} (provided by VerticalModule).
 */
@Module({
  imports: [
    AuthModule,
    NotificationModule,
    VerticalModule,
    ActivityModule,
    TypeOrmModule.forFeature([MeetingEntity, MeetingNoticeEntity, UserEntity]),
  ],
  controllers: [MeetingsController],
  providers: [MeetingsService, MeetingsCronService],
  exports: [MeetingsService],
})
export class MeetingsModule {}
