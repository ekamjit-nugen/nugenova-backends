import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PostgresModule } from './bootstrap/database/postgres.module';
import { MailModule } from './bootstrap/mail/mail.module';
import { StorageModule } from './bootstrap/storage/storage.module';
import { TermsModule } from './modules/terms/terms.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { AdminPlaybooksModule } from './modules/admin-playbooks/admin-playbooks.module';
import { OrganizationModule } from './modules/organization/organization.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { PolicyModule } from './modules/policy/policy.module';
import { AttendanceModule } from './modules/attendance/attendance.module';
import { NotificationModule } from './modules/notification/notification.module';
import { AdminPlatformModule } from './modules/admin-platform/admin-platform.module';

/**
 * Nugenova backend root module.
 *
 * Postgres-only. Migrated modules are added to the imports below one at a time
 * (auth first). ScheduleModule.forRoot() is registered ONCE here — feature
 * modules must not call it again.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env.local', '.env'] }),
    PostgresModule,
    ScheduleModule.forRoot(),
    MailModule,
    StorageModule,
    TermsModule,
    HealthModule,
    // ── migrated modules land here ──
    AuthModule,
    AdminPlaybooksModule,
    OrganizationModule,
    OnboardingModule,
    PolicyModule,
    AttendanceModule,
    NotificationModule,
    AdminPlatformModule,
  ],
})
export class AppModule {}
