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
import { LeaveModule } from './modules/leave/leave.module';
import { PayrollModule } from './modules/payroll/payroll.module';
import { TimesheetModule } from './modules/timesheet/timesheet.module';
import { NotificationModule } from './modules/notification/notification.module';
import { AdminPlatformModule } from './modules/admin-platform/admin-platform.module';
import { ChatModule } from './modules/chat/chat.module';
import { AcademicModule } from './modules/academic/academic.module';
import { LmsModule } from './modules/lms/lms.module';
import { VerticalModule } from './modules/vertical/vertical.module';
import { GuardianModule } from './modules/guardian/guardian.module';
import { PlatformEventsModule } from './modules/platform-events/platform-events.module';

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
    // Global domain event bus (§08 layer 1) — registers EventEmitterModule.forRoot()
    // ONCE (like ScheduleModule) and exposes DomainEventsService. Also serves chat's
    // in-process bus: MessagesService emits and ChatGateway @OnEvent listens through
    // this same EventEmitter2, avoiding a service↔gateway circular dependency.
    PlatformEventsModule,
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
    LeaveModule,
    PayrollModule,
    TimesheetModule,
    NotificationModule,
    AdminPlatformModule,
    ChatModule,
    AcademicModule,
    LmsModule,
    VerticalModule,
    GuardianModule,
  ],
})
export class AppModule {}
