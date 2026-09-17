import { Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PostgresModule } from './bootstrap/database/postgres.module';
import { MailModule } from './bootstrap/mail/mail.module';
import { ErrorsModule } from './bootstrap/errors/errors.module';
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
import { AssessmentModule } from './modules/assessment/assessment.module';
import { VerticalModule } from './modules/vertical/vertical.module';
import { GuardianModule } from './modules/guardian/guardian.module';
import { PlatformEventsModule } from './modules/platform-events/platform-events.module';
import { DriveModule } from './modules/storage/drive.module';
import { AiModule } from './modules/ai/ai.module';
import { KnowledgeModule } from './modules/knowledge/knowledge.module';
import { AiChatModule } from './modules/ai-chat/ai-chat.module';
import { DiscussionBoardsModule } from './modules/discussion-boards/discussion-boards.module';
import { ClientsModule } from './modules/clients/clients.module';
import { SalesModule } from './modules/sales/sales.module';
import { ActivityModule } from './modules/activity/activity.module';
import { MeetingsModule } from './modules/meetings/meetings.module';
import { CalendarModule } from './modules/calendar/calendar.module';
import { RecruitmentModule } from './modules/recruitment/recruitment.module';

/**
 * Scheduled jobs (@Cron: attendance absent marking and reminders, the daily
 * attendance summary, onboarding reminders, retention…) run only when
 * ScheduleModule is registered. `ENABLE_SCHEDULED_JOBS=false` leaves it out, so
 * every @Cron is inert.
 *
 * Production leaves it unset (jobs on). Set it to false anywhere else that
 * points at a shared database — otherwise a local `npm run dev` runs the same
 * jobs against that data a second time. Read after ConfigModule.forRoot() has
 * loaded .env, so it can be set there or in the shell.
 */
function scheduledJobs() {
  if (String(process.env.ENABLE_SCHEDULED_JOBS ?? '').trim().toLowerCase() === 'false') {
    new Logger('Scheduler').warn('ENABLE_SCHEDULED_JOBS=false — scheduled jobs are OFF for this process');
    return [];
  }
  return [ScheduleModule.forRoot()];
}

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
    // Must stay after ConfigModule.forRoot(), which loads .env into process.env.
    ...scheduledJobs(),
    // Global domain event bus (§08 layer 1) — registers EventEmitterModule.forRoot()
    // ONCE (like ScheduleModule) and exposes DomainEventsService. Also serves chat's
    // in-process bus: MessagesService emits and ChatGateway @OnEvent listens through
    // this same EventEmitter2, avoiding a service↔gateway circular dependency.
    PlatformEventsModule,
    MailModule,
    // Global exception filter: every failed request becomes an activity row,
    // and a 5xx also emails the complete reason. Early in the list so it is in
    // place before the feature modules it covers.
    ErrorsModule,
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
    AssessmentModule,
    VerticalModule,
    GuardianModule,
    DriveModule,
    AiModule,
    KnowledgeModule,
    AiChatModule,
    DiscussionBoardsModule,
    ClientsModule,
    SalesModule,
    ActivityModule,
    MeetingsModule,
    CalendarModule,
    RecruitmentModule,
  ],
})
export class AppModule {}
