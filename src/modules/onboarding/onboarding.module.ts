import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { PolicyModule } from '../policy/policy.module';
import { NotificationModule } from '../notification/notification.module';
import { OnboardingDocumentTemplateEntity } from './entities/onboarding-document-template.entity';
import { OnboardingDocumentRequestEntity } from './entities/onboarding-document-request.entity';
import { MemberOnboardingEntity } from './entities/member-onboarding.entity';
import { OrganizationEntity } from '../organization/entities/organization.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';

import { DocumentTemplateService } from './services/document-template.service';
import { OnboardingService } from './services/onboarding.service';
import { OnboardingLifecycleService } from './services/member-onboarding.service';
import { OnboardingOwnerGuard } from './guards/onboarding-owner.guard';
import { OnboardingAccessGuard } from './guards/onboarding-access.guard';

import { AdminOnboardingController } from './admin-onboarding.controller';
import { OnboardingController } from './onboarding.controller';
import { MemberOnboardingController } from './member-onboarding.controller';
import { MyOnboardingController } from './my-onboarding.controller';

/**
 * Org onboarding + document approval. A super admin requests documents from a
 * newly-provisioned (onboarding-status) org; the owner signs/uploads them via the
 * `/onboarding` surface; the super admin approves each; the org flips to `active`
 * only once every document is approved.
 *
 * Depends on AuthModule (JWT + platform-admin guards) and the global MailModule /
 * StorageModule (injected implicitly). Templates seed on boot.
 */
@Module({
  imports: [
    AuthModule,
    PolicyModule,
    NotificationModule,
    TypeOrmModule.forFeature([
      OnboardingDocumentTemplateEntity,
      OnboardingDocumentRequestEntity,
      MemberOnboardingEntity,
      OrganizationEntity,
      UserEntity,
      OrgMembershipEntity,
    ]),
  ],
  controllers: [
    AdminOnboardingController,
    OnboardingController,
    MemberOnboardingController,
    MyOnboardingController,
  ],
  providers: [
    DocumentTemplateService,
    OnboardingService,
    OnboardingLifecycleService,
    OnboardingOwnerGuard,
    OnboardingAccessGuard,
  ],
  exports: [OnboardingService, DocumentTemplateService, OnboardingLifecycleService],
})
export class OnboardingModule {}
