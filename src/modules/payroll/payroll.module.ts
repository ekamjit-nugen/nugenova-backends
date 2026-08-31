import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { AttendanceModule } from '../attendance/attendance.module';
import { LeaveModule } from '../leave/leave.module';
import { PolicyModule } from '../policy/policy.module';
import { NotificationModule } from '../notification/notification.module';
import { SalaryStructureEntity } from './entities/salary-structure.entity';
import { PayslipEntity } from './entities/payslip.entity';
import { OrganizationEntity } from '../organization/entities/organization.entity';
import { DepartmentEntity } from '../organization/entities/department.entity';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { UserEntity } from '../auth/entities/user.entity';

import { PayrollService } from './services/payroll.service';
import { PayrollAccessGuard } from './guards/payroll-access.guard';
import { PayrollController } from './payroll.controller';

/**
 * Payroll (Phase 1 — simple path): per-employee monthly salary → generate monthly
 * payslips (salary − LOP) → employee self-service payslips. Draws LOP from
 * Attendance (day summary) + Leave (paid vs lop days). Org-scoped and
 * permission-gated via PayrollAccessGuard.
 */
@Module({
  imports: [
    AuthModule,
    AttendanceModule,
    LeaveModule,
    PolicyModule,
    NotificationModule,
    TypeOrmModule.forFeature([
      SalaryStructureEntity,
      PayslipEntity,
      OrganizationEntity,
      DepartmentEntity,
      OrgMembershipEntity,
      UserEntity,
    ]),
  ],
  controllers: [PayrollController],
  providers: [PayrollService, PayrollAccessGuard],
  exports: [PayrollService],
})
export class PayrollModule {}
