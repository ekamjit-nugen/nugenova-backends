import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { NotificationModule } from '../notification/notification.module';
import { ActivityModule } from '../activity/activity.module';
import { AiModule } from '../ai/ai.module';
import { MeetingsModule } from '../meetings/meetings.module';
import { SalesModule } from '../sales/sales.module';
import { LeadEntity } from '../sales/entities/lead.entity';
import { RequirementEntity } from '../sales/entities/requirement.entity';
import { SalesFollowupEntity } from '../sales/entities/sales-followup.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { OrganizationEntity } from '../organization/entities/organization.entity';

import { RECRUITMENT_ENTITIES } from './entities';
import { RecruitmentAccessGuard } from './guards/recruitment-access.guard';
import { PipelineService } from './services/pipeline.service';
import { CvParseService } from './services/cv-parse.service';
import { CandidatesService } from './services/candidates.service';
import { OpeningsService } from './services/openings.service';
import { InterviewsService } from './services/interviews.service';
import { OffersService } from './services/offers.service';
import { RecruitmentAnalyticsService } from './services/analytics.service';
import { ImportExportService } from './services/import-export.service';
import { SubmissionsService } from './services/submissions.service';
import { MatchingService } from './services/matching.service';
import { LeadWorkspaceService } from './services/lead-workspace.service';
import { LeadsController } from './controllers/leads.controller';
import { CandidatesController } from './controllers/candidates.controller';
import { PipelineController } from './controllers/pipeline.controller';
import { InterviewsController } from './controllers/interviews.controller';

/**
 * Recruitment (ATS) — talent pool, job openings, pipeline board, AI CV parsing,
 * interviews + scorecards, offers → onboarding handoff, analytics and Excel
 * import/export. Org-scoped and permission-gated on the `recruitment` resource
 * via RecruitmentAccessGuard (see PLAYBOOK.md).
 */
@Module({
  imports: [
    AuthModule,
    NotificationModule,
    ActivityModule,
    AiModule,
    MeetingsModule,
    SalesModule,
    TypeOrmModule.forFeature([
      ...RECRUITMENT_ENTITIES, UserEntity, OrgMembershipEntity, OrganizationEntity, LeadEntity, RequirementEntity, SalesFollowupEntity,
    ]),
  ],
  controllers: [CandidatesController, PipelineController, InterviewsController, LeadsController],
  providers: [
    RecruitmentAccessGuard,
    PipelineService,
    CvParseService,
    CandidatesService,
    OpeningsService,
    InterviewsService,
    OffersService,
    RecruitmentAnalyticsService,
    ImportExportService,
    SubmissionsService,
    MatchingService,
    LeadWorkspaceService,
  ],
  exports: [CandidatesService, PipelineService, SubmissionsService],
})
export class RecruitmentModule {}
