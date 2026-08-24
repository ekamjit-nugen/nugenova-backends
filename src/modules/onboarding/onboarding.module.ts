import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { OnboardingDocumentTemplateEntity } from './entities/onboarding-document-template.entity';
import { OnboardingDocumentRequestEntity } from './entities/onboarding-document-request.entity';
import { OrganizationEntity } from '../organization/entities/organization.entity';
import { UserEntity } from '../auth/entities/user.entity';

import { DocumentTemplateService } from './services/document-template.service';
import { OnboardingService } from './services/onboarding.service';
import { OnboardingOwnerGuard } from './guards/onboarding-owner.guard';

import { AdminOnboardingController } from './admin-onboarding.controller';
import { OnboardingController } from './onboarding.controller';

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
    TypeOrmModule.forFeature([
      OnboardingDocumentTemplateEntity,
      OnboardingDocumentRequestEntity,
      OrganizationEntity,
      UserEntity,
    ]),
  ],
  controllers: [AdminOnboardingController, OnboardingController],
  providers: [DocumentTemplateService, OnboardingService, OnboardingOwnerGuard],
  exports: [OnboardingService, DocumentTemplateService],
})
export class OnboardingModule {}
