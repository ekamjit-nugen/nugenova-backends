import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AllExceptionsFilter } from './all-exceptions.filter';
import { ErrorReporterService } from './error-reporter.service';
import { ActivityModule } from '../../modules/activity/activity.module';
import { OrganizationEntity } from '../../modules/organization/entities/organization.entity';
import { OrgMembershipEntity } from '../../modules/auth/entities/org-membership.entity';
import { UserEntity } from '../../modules/auth/entities/user.entity';

/**
 * Registers the app-wide exception filter. Imported by AppModule; APP_FILTER
 * makes it global without an explicit `useGlobalFilters` in main.ts, so it is
 * also active in tests that build the module.
 */
@Module({
  imports: [
    ActivityModule,
    TypeOrmModule.forFeature([OrganizationEntity, OrgMembershipEntity, UserEntity]),
  ],
  providers: [ErrorReporterService, { provide: APP_FILTER, useClass: AllExceptionsFilter }],
  exports: [ErrorReporterService],
})
export class ErrorsModule {}
