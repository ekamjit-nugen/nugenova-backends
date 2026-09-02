import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { AttendanceModule } from '../attendance/attendance.module';
import { LeaveModule } from '../leave/leave.module';
import { PolicyModule } from '../policy/policy.module';
import { NotificationModule } from '../notification/notification.module';
import { SalaryStructureEntity } from './entities/salary-structure.entity';
import { PayslipEntity } from './entities/payslip.entity';
import { PayrollRunEntity } from './entities/payroll-run.entity';
import { TaxDeclarationEntity } from './entities/tax-declaration.entity';
import { OrganizationEntity } from '../organization/entities/organization.entity';
import { DepartmentEntity } from '../organization/entities/department.entity';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { UserEntity } from '../auth/entities/user.entity';

import { PayrollService } from './services/payroll.service';
import { TaxDeclarationService } from './services/tax-declaration.service';
import { PayrollAccessGuard } from './guards/payroll-access.guard';
import { PayrollController } from './payroll.controller';
import { TaxDeclarationController } from './tax-declaration.controller';

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
      PayrollRunEntity,
      TaxDeclarationEntity,
      OrganizationEntity,
      DepartmentEntity,
      OrgMembershipEntity,
      UserEntity,
    ]),
  ],
  controllers: [PayrollController, TaxDeclarationController],
  providers: [PayrollService, TaxDeclarationService, PayrollAccessGuard],
  exports: [PayrollService, TaxDeclarationService],
})
export class PayrollModule {}
