import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
// Same env the app loads. Must run before we read DATABASE_URL.
loadEnv({ path: ['.env.local', '.env'] });

import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';

import { UserEntity } from '../src/modules/auth/entities/user.entity';
import { OrgMembershipEntity } from '../src/modules/auth/entities/org-membership.entity';
import { SessionEntity } from '../src/modules/auth/entities/session.entity';
import { RoleEntity } from '../src/modules/auth/entities/role.entity';
import { RevokedTokenEntity } from '../src/modules/auth/entities/revoked-token.entity';
import { OrganizationEntity } from '../src/modules/organization/entities/organization.entity';
import { DepartmentEntity } from '../src/modules/organization/entities/department.entity';
import { EmailOutboxEntity } from '../src/bootstrap/mail/email-outbox.entity';
import { DocumentFileEntity } from '../src/bootstrap/storage/document-file.entity';
import { OnboardingDocumentTemplateEntity } from '../src/modules/onboarding/entities/onboarding-document-template.entity';
import { OnboardingDocumentRequestEntity } from '../src/modules/onboarding/entities/onboarding-document-request.entity';
import { MemberOnboardingEntity } from '../src/modules/onboarding/entities/member-onboarding.entity';
import { AuthUsersInitial1787316090532 } from '../src/bootstrap/database/migrations/1787316090532-AuthUsersInitial';
import { AuthSessionsRolesTokens1787334496372 } from '../src/bootstrap/database/migrations/1787334496372-AuthSessionsRolesTokens';
import { OrganizationDepartments1787546870935 } from '../src/bootstrap/database/migrations/1787546870935-OrganizationDepartments';
import { DepartmentCodeCostCenter1787552806757 } from '../src/bootstrap/database/migrations/1787552806757-DepartmentCodeCostCenter';
import { OnboardingDocuments1787640000000 } from '../src/bootstrap/database/migrations/1787640000000-OnboardingDocuments';
import { OnboardingSourceFile1787660000000 } from '../src/bootstrap/database/migrations/1787660000000-OnboardingSourceFile';
import { TermsConsent1787680000000 } from '../src/bootstrap/database/migrations/1787680000000-TermsConsent';
import { TermsSourceKind1787700000000 } from '../src/bootstrap/database/migrations/1787700000000-TermsSourceKind';
import { TermsLibrary1787720000000 } from '../src/bootstrap/database/migrations/1787720000000-TermsLibrary';
import { OrgOnboarding1787740000000 } from '../src/bootstrap/database/migrations/1787740000000-OrgOnboarding';
import { AttendanceHolidays1787800000000 } from '../src/bootstrap/database/migrations/1787800000000-AttendanceHolidays';
import { Policies1787810000000 } from '../src/bootstrap/database/migrations/1787810000000-Policies';
import { PolicyVersionsAttachments1787820000000 } from '../src/bootstrap/database/migrations/1787820000000-PolicyVersionsAttachments';
import { RoleTierSystem1787830000000 } from '../src/bootstrap/database/migrations/1787830000000-RoleTierSystem';
import { MemberOnboarding1787840000000 } from '../src/bootstrap/database/migrations/1787840000000-MemberOnboarding';
import { WfhRequests1787850000000 } from '../src/bootstrap/database/migrations/1787850000000-WfhRequests';
import { Notifications1787860000000 } from '../src/bootstrap/database/migrations/1787860000000-Notifications';
import { NotificationPreferences1787870000000 } from '../src/bootstrap/database/migrations/1787870000000-NotificationPreferences';
import { Leave1787880000000 } from '../src/bootstrap/database/migrations/1787880000000-Leave';
import { Payroll1787890000000 } from '../src/bootstrap/database/migrations/1787890000000-Payroll';
import { PayrollStatutory1787900000000 } from '../src/bootstrap/database/migrations/1787900000000-PayrollStatutory';
import { PayrollRecurringDeductions1787910000000 } from '../src/bootstrap/database/migrations/1787910000000-PayrollRecurringDeductions';
import { PayrollRun1787920000000 } from '../src/bootstrap/database/migrations/1787920000000-PayrollRun';
import { PayrollTds1787930000000 } from '../src/bootstrap/database/migrations/1787930000000-PayrollTds';
import { TaxDeclaration1787940000000 } from '../src/bootstrap/database/migrations/1787940000000-TaxDeclaration';
import { StatutoryIds1787950000000 } from '../src/bootstrap/database/migrations/1787950000000-StatutoryIds';
import { BankAccount1787960000000 } from '../src/bootstrap/database/migrations/1787960000000-BankAccount';
import { Timesheets1787970000000 } from '../src/bootstrap/database/migrations/1787970000000-Timesheets';
import { TermsActive1787980000000 } from '../src/bootstrap/database/migrations/1787980000000-TermsActive';
import { NotificationEmailChannel1787990000000 } from '../src/bootstrap/database/migrations/1787990000000-NotificationEmailChannel';
import { OrgNotificationSettings1788000000000 } from '../src/bootstrap/database/migrations/1788000000000-OrgNotificationSettings';
import { OrgNotificationTypes1788010000000 } from '../src/bootstrap/database/migrations/1788010000000-OrgNotificationTypes';
import { Chat1788020000000 } from '../src/bootstrap/database/migrations/1788020000000-Chat';
import { MembershipPersonType1788030000000 } from '../src/bootstrap/database/migrations/1788030000000-MembershipPersonType';
import { Academic1788031000000 } from '../src/bootstrap/database/migrations/1788031000000-Academic';
import { Lms1788032000000 } from '../src/bootstrap/database/migrations/1788032000000-Lms';
import { VerticalPack1788033000000 } from '../src/bootstrap/database/migrations/1788033000000-VerticalPack';
import { Guardian1788034000000 } from '../src/bootstrap/database/migrations/1788034000000-Guardian';
import { ChatBookmark1788040000000 } from '../src/bootstrap/database/migrations/1788040000000-ChatBookmark';
import { OrgChatSettings1788050000000 } from '../src/bootstrap/database/migrations/1788050000000-OrgChatSettings';
import { CloudDrive1788080000000 } from '../src/bootstrap/database/migrations/1788080000000-CloudDrive';
import { PlatformTermsEntity } from '../src/modules/terms/entities/platform-terms.entity';
import { AttendanceEntity } from '../src/modules/attendance/entities/attendance.entity';
import { HolidayEntity } from '../src/modules/attendance/entities/holiday.entity';
import { WfhRequestEntity } from '../src/modules/attendance/entities/wfh-request.entity';
import { PolicyEntity } from '../src/modules/policy/entities/policy.entity';
import { PolicyAcknowledgementEntity } from '../src/modules/policy/entities/policy-acknowledgement.entity';
import { PolicyVersionEntity } from '../src/modules/policy/entities/policy-version.entity';
import { NotificationEntity } from '../src/modules/notification/entities/notification.entity';
import { NotificationPreferenceEntity } from '../src/modules/notification/entities/notification-preference.entity';
import { OrgNotificationSettingEntity } from '../src/modules/notification/entities/org-notification-setting.entity';
import { SalaryStructureEntity } from '../src/modules/payroll/entities/salary-structure.entity';
import { PayslipEntity } from '../src/modules/payroll/entities/payslip.entity';
import { PayrollRunEntity } from '../src/modules/payroll/entities/payroll-run.entity';
import { TaxDeclarationEntity } from '../src/modules/payroll/entities/tax-declaration.entity';
import { LeaveRequestEntity } from '../src/modules/leave/entities/leave-request.entity';
import { LeaveBalanceEntity } from '../src/modules/leave/entities/leave-balance.entity';
import { TimesheetEntity } from '../src/modules/timesheet/entities/timesheet.entity';
import { ConversationEntity } from '../src/modules/chat/entities/conversation.entity';
import { MessageEntity } from '../src/modules/chat/entities/message.entity';
import { ChatBookmarkEntity } from '../src/modules/chat/entities/chat-bookmark.entity';
import { OrgChatSettingEntity } from '../src/modules/chat/entities/org-chat-setting.entity';
import { AcademicYearEntity } from '../src/modules/academic/entities/academic-year.entity';
import { TermEntity } from '../src/modules/academic/entities/term.entity';
import { CourseEntity } from '../src/modules/lms/entities/course.entity';
import { ClassSectionEntity } from '../src/modules/lms/entities/class-section.entity';
import { EnrolmentEntity } from '../src/modules/lms/entities/enrolment.entity';
import { GuardianLinkEntity } from '../src/modules/guardian/entities/guardian-link.entity';
import { ConsentLedgerEntity } from '../src/modules/guardian/entities/consent-ledger.entity';
import { DriveFolderEntity } from '../src/modules/storage/entities/drive-folder.entity';
import { DriveFileEntity } from '../src/modules/storage/entities/drive-file.entity';
import { DriveShareEntity } from '../src/modules/storage/entities/drive-share.entity';
import { DriveQuotaEntity } from '../src/modules/storage/entities/drive-quota.entity';

/**
 * Jest globalSetup for the e2e suite. Runs ONCE before the app boots and makes
 * the auth schema exist on whatever DATABASE_URL points at:
 *
 *  - Supabase (local .env.local): `users` + `org_memberships` already exist from
 *    the ETL and the auth migration has already run, so this is effectively a
 *    no-op — it only fills any gap.
 *  - Ephemeral empty Postgres (CI): NOTHING exists yet. The auth migration only
 *    provisions sessions/roles/revoked_tokens (users/org_memberships pre-exist on
 *    Supabase and were never captured in a migration in this repo), so on an
 *    empty DB we build the full auth schema from the entity metadata instead.
 *
 * Mirrors data-source.ts's connection/ssl logic but references the entity/
 * migration CLASSES directly — the string globs data-source.ts uses can't be
 * required as `.ts` from inside TypeORM under ts-jest.
 */
module.exports = async function globalSetup(): Promise<void> {
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set — e2e tests need a Postgres connection string.',
    );
  }
  const isLocal = url.includes('localhost') || url.includes('127.0.0.1');

  const ds = new DataSource({
    type: 'postgres',
    url,
    ssl: url && !isLocal ? { rejectUnauthorized: false } : false,
    entities: [
      UserEntity,
      OrgMembershipEntity,
      SessionEntity,
      RoleEntity,
      RevokedTokenEntity,
      OrganizationEntity,
      DepartmentEntity,
      EmailOutboxEntity,
      DocumentFileEntity,
      OnboardingDocumentTemplateEntity,
      OnboardingDocumentRequestEntity,
      MemberOnboardingEntity,
      PlatformTermsEntity,
      AttendanceEntity,
      HolidayEntity,
      WfhRequestEntity,
      PolicyEntity,
      PolicyAcknowledgementEntity,
      PolicyVersionEntity,
      NotificationEntity,
      NotificationPreferenceEntity,
      LeaveRequestEntity,
      LeaveBalanceEntity,
      TimesheetEntity,
      SalaryStructureEntity,
      PayslipEntity,
      PayrollRunEntity,
      TaxDeclarationEntity,
      ConversationEntity,
      MessageEntity,
      ChatBookmarkEntity,
      OrgChatSettingEntity,
      AcademicYearEntity,
      TermEntity,
      CourseEntity,
      ClassSectionEntity,
      EnrolmentEntity,
      GuardianLinkEntity,
      ConsentLedgerEntity,
      DriveFolderEntity,
      DriveFileEntity,
      DriveShareEntity,
      DriveQuotaEntity,
    ],
    // NOTE: keep this list in sync with every migration under
    // src/bootstrap/database/migrations — ts-jest can't load the glob
    // data-source.ts uses, so new migrations MUST be added here or CI's fresh
    // DB will be missing their columns.
    migrations: [
      AuthUsersInitial1787316090532,
      AuthSessionsRolesTokens1787334496372,
      OrganizationDepartments1787546870935,
      DepartmentCodeCostCenter1787552806757,
      OnboardingDocuments1787640000000,
      OnboardingSourceFile1787660000000,
      TermsConsent1787680000000,
      TermsSourceKind1787700000000,
      TermsLibrary1787720000000,
      OrgOnboarding1787740000000,
      AttendanceHolidays1787800000000,
      Policies1787810000000,
      PolicyVersionsAttachments1787820000000,
      RoleTierSystem1787830000000,
      MemberOnboarding1787840000000,
      WfhRequests1787850000000,
      Notifications1787860000000,
      NotificationPreferences1787870000000,
      Leave1787880000000,
      Payroll1787890000000,
      PayrollStatutory1787900000000,
      PayrollRecurringDeductions1787910000000,
      PayrollRun1787920000000,
      PayrollTds1787930000000,
      TaxDeclaration1787940000000,
      StatutoryIds1787950000000,
      BankAccount1787960000000,
      Timesheets1787970000000,
      TermsActive1787980000000,
      NotificationEmailChannel1787990000000,
      OrgNotificationSettings1788000000000,
      OrgNotificationTypes1788010000000,
      Chat1788020000000,
      MembershipPersonType1788030000000,
      Academic1788031000000,
      Lms1788032000000,
      VerticalPack1788033000000,
      Guardian1788034000000,
      ChatBookmark1788040000000,
      OrgChatSettings1788050000000,
      CloudDrive1788080000000,
    ],
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: false,
  });

  await ds.initialize();
  try {
    // Idempotent: TypeORM skips migrations already recorded in the `migrations`
    // table. On populated Supabase both auth migrations are already logged, so
    // this is a no-op; on an empty CI Postgres both run and provision the full
    // auth schema (users + org_memberships, then sessions/roles/revoked_tokens).
    await ds.runMigrations();
  } finally {
    await ds.destroy();
  }
};
