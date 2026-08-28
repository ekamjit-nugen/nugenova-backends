import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { RoleEntity } from '../auth/entities/role.entity';
import { NotificationEntity } from './entities/notification.entity';
import { NotificationPreferenceEntity } from './entities/notification-preference.entity';
import { NotificationService } from './notification.service';
import { NotificationPreferenceService } from './notification-preference.service';
import { NotifierService } from './notifier.service';
import { NotificationController } from './notification.controller';

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
      OrgMembershipEntity,
      RoleEntity,
    ]),
  ],
  controllers: [NotificationController],
  providers: [NotificationService, NotificationPreferenceService, NotifierService],
  exports: [NotifierService, NotificationService, NotificationPreferenceService],
})
export class NotificationModule {}
