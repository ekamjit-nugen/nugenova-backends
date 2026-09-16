import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { RoleEntity } from '../auth/entities/role.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { NotificationEntity } from './entities/notification.entity';
import { NotificationPreferenceEntity } from './entities/notification-preference.entity';
import { OrgNotificationSettingEntity } from './entities/org-notification-setting.entity';
import { NotificationService } from './notification.service';
import { NotificationPreferenceService } from './notification-preference.service';
import { OrgNotificationSettingService } from './org-notification-setting.service';
import { NotifierService } from './notifier.service';
import { NotificationController } from './notification.controller';
import { PushTokenEntity } from './entities/push-token.entity';
import { FcmClient } from './push/fcm.client';
import { PushService } from './push/push.service';
import { PushController } from './push/push.controller';

/**
 * Notification — the per-recipient in-app inbox (see PLAYBOOK.md). Persists every
 * notification a user is sent, isolates it to that user, and lets the panel route
 * a tap to the respective page.
 *
 * Exports `NotifierService` (the cross-module publishing spine) and
 * `NotificationService`; any module that wants to emit notifications imports
 * NotificationModule and injects `NotifierService`. Registers OrgMembership/Role
 * so the notifier can resolve an org's approvers for `notifyManagers`.
 */
@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([
      NotificationEntity,
      NotificationPreferenceEntity,
      OrgNotificationSettingEntity,
      PushTokenEntity,
      OrgMembershipEntity,
      RoleEntity,
      UserEntity,
    ]),
  ],
  controllers: [NotificationController, PushController],
  providers: [
    NotificationService,
    NotificationPreferenceService,
    OrgNotificationSettingService,
    NotifierService,
    FcmClient,
    PushService,
  ],
  exports: [
    PushService,
    NotifierService,
    NotificationService,
    NotificationPreferenceService,
    OrgNotificationSettingService,
  ],
})
export class NotificationModule {}
