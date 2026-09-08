import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { ClassSectionEntity } from '../lms/entities/class-section.entity';
import { EnrolmentEntity } from '../lms/entities/enrolment.entity';
import { AssessmentEntity } from './entities/assessment.entity';
import { MarkEntity } from './entities/mark.entity';
import { AssessmentService } from './assessment.service';
import { AssessmentAccessGuard } from './guards/assessment-access.guard';
import { AssessmentController } from './assessment.controller';

/**
 * Assessment / gradebook — the education-vertical GRADEBOOK layer (assessments +
 * per-student marks) sitting on the lms roster (`class_sections` + `enrolments`)
 * and, through the class, on the academic calendar. Owner/admin authored,
 * tenant-scoped. Imports AuthModule for the JWT guard and reads OrgMembership /
 * User to enforce the personType invariant (only students are graded) and to
 * render gradebooks/reports. See PLAYBOOK.md.
 */
@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([
      AssessmentEntity,
      MarkEntity,
      ClassSectionEntity,
      EnrolmentEntity,
      OrgMembershipEntity,
      UserEntity,
    ]),
  ],
  controllers: [AssessmentController],
  providers: [AssessmentService, AssessmentAccessGuard],
  exports: [AssessmentService],
})
export class AssessmentModule {}
