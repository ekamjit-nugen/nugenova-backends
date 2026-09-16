export { RecruitmentOpeningEntity } from './recruitment-opening.entity';
export { RecruitmentStageEntity } from './recruitment-stage.entity';
export { CandidateEntity } from './candidate.entity';
export { CandidateDocumentEntity } from './candidate-document.entity';
export { CandidateApplicationEntity } from './candidate-application.entity';
export { ApplicationStageEventEntity } from './application-stage-event.entity';
export { InterviewEntity } from './interview.entity';
export { InterviewFeedbackEntity } from './interview-feedback.entity';
export { ScorecardTemplateEntity } from './scorecard-template.entity';
export { CandidateOfferEntity } from './candidate-offer.entity';
export { CandidateActivityEntity } from './candidate-activity.entity';
export { RecruitmentSettingsEntity } from './recruitment-settings.entity';
export { RecruitmentSubmissionEntity } from './recruitment-submission.entity';
export { SubmissionEventEntity } from './submission-event.entity';

import { RecruitmentOpeningEntity } from './recruitment-opening.entity';
import { RecruitmentStageEntity } from './recruitment-stage.entity';
import { CandidateEntity } from './candidate.entity';
import { CandidateDocumentEntity } from './candidate-document.entity';
import { CandidateApplicationEntity } from './candidate-application.entity';
import { ApplicationStageEventEntity } from './application-stage-event.entity';
import { InterviewEntity } from './interview.entity';
import { InterviewFeedbackEntity } from './interview-feedback.entity';
import { ScorecardTemplateEntity } from './scorecard-template.entity';
import { CandidateOfferEntity } from './candidate-offer.entity';
import { CandidateActivityEntity } from './candidate-activity.entity';
import { RecruitmentSettingsEntity } from './recruitment-settings.entity';
import { RecruitmentSubmissionEntity } from './recruitment-submission.entity';
import { SubmissionEventEntity } from './submission-event.entity';

/** Every entity the module owns (for TypeOrmModule.forFeature + test setup). */
export const RECRUITMENT_ENTITIES = [
  RecruitmentOpeningEntity,
  RecruitmentStageEntity,
  CandidateEntity,
  CandidateDocumentEntity,
  CandidateApplicationEntity,
  ApplicationStageEventEntity,
  InterviewEntity,
  InterviewFeedbackEntity,
  ScorecardTemplateEntity,
  CandidateOfferEntity,
  CandidateActivityEntity,
  RecruitmentSettingsEntity,
  RecruitmentSubmissionEntity,
  SubmissionEventEntity,
];
