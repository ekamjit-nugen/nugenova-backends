import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { AcademicYearEntity } from './entities/academic-year.entity';
import { TermEntity } from './entities/term.entity';
import { AcademicService } from './academic.service';
import { AcademicAccessGuard } from './guards/academic-access.guard';
import { AcademicController } from './academic.controller';

/**
 * Academic — the education-vertical FOUNDATION: the per-org academic calendar
 * (years + ordered terms) the future gradebook/enrolment anchor to. Owner/admin
 * only, tenant-scoped. Imports AuthModule for the JWT guard. See PLAYBOOK.md and
 * the personType/staffScope guard it ships alongside.
 */
@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([AcademicYearEntity, TermEntity]),
  ],
  controllers: [AcademicController],
  providers: [AcademicService, AcademicAccessGuard],
  exports: [AcademicService],
})
export class AcademicModule {}
