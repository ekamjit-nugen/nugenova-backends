import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { VerticalModule } from '../vertical/vertical.module';
import { UserEntity } from '../auth/entities/user.entity';
import { OrganizationEntity } from '../organization/entities/organization.entity';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';

import { ActivityEventEntity } from './entities/activity-event.entity';
import { ActivityRetentionRunEntity } from './entities/activity-retention-run.entity';
import { ActivityService } from './activity.service';
import { ActivityRetentionService } from './activity-retention.service';
import { ActivityCronService } from './activity-cron.service';
import { ActivityController } from './activity.controller';

/**
 * Activity — the unified, curated activity feed plus its 15-day retention job.
 * `ActivityService` is exported so any module can record events; the global
 * MailModule supplies mail for the retention backup.
 */
@Module({
  imports: [
    AuthModule,
    VerticalModule,
    TypeOrmModule.forFeature([ActivityEventEntity, ActivityRetentionRunEntity, UserEntity, OrganizationEntity, OrgMembershipEntity]),
  ],
  controllers: [ActivityController],
  providers: [ActivityService, ActivityRetentionService, ActivityCronService],
  exports: [ActivityService],
})
export class ActivityModule {}
