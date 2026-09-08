import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { TermEntity } from '../academic/entities/term.entity';
import { CourseEntity } from './entities/course.entity';
import { ClassSectionEntity } from './entities/class-section.entity';
import { EnrolmentEntity } from './entities/enrolment.entity';
import { LmsService } from './lms.service';
import { LmsAccessGuard } from './guards/lms-access.guard';
import { LmsController } from './lms.controller';

/**
 * LMS — the education-vertical STRUCTURE + ENROLMENT layer (courses, class/
 * sections, enrolment) sitting on the academic calendar. Owner/admin authored,
 * tenant-scoped. Imports AuthModule for the JWT guard and reads OrgMembership /
 * User to enforce the personType invariants (teacher must be staff, enrolee must
 * be a student) and to render class rosters. See PLAYBOOK.md.
 */
@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([
      CourseEntity,
      ClassSectionEntity,
      EnrolmentEntity,
      TermEntity,
      OrgMembershipEntity,
      UserEntity,
    ]),
  ],
  controllers: [LmsController],
  providers: [LmsService, LmsAccessGuard],
  exports: [LmsService],
})
export class LmsModule {}
