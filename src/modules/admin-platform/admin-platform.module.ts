import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { OrganizationEntity } from '../organization/entities/organization.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { NotificationEntity } from '../notification/entities/notification.entity';
import { SessionEntity } from '../auth/entities/session.entity';
import { EmailOutboxEntity } from '../../bootstrap/mail/email-outbox.entity';

import { AdminPlatformService } from './admin-platform.service';
import { AdminPlatformController } from './admin-platform.controller';

/**
 * Admin platform — the super admin's cross-tenant PLATFORM operations overview.
 * Registers (read-only) only the account/security/infra entities it aggregates —
 * deliberately NOT tenant business entities (payroll/leave/policy/attendance/…),
 * which stay private to each organization. AuthModule supplies the JWT +
 * platform-admin guards.
 */
@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([
      OrganizationEntity,
      UserEntity,
      OrgMembershipEntity,
      NotificationEntity,
      SessionEntity,
      EmailOutboxEntity,
    ]),
  ],
  controllers: [AdminPlatformController],
  providers: [AdminPlatformService],
})
export class AdminPlatformModule {}
