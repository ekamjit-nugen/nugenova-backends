import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { PolicyEntity } from './entities/policy.entity';
import { PolicyAcknowledgementEntity } from './entities/policy-acknowledgement.entity';
import { PolicyVersionEntity } from './entities/policy-version.entity';
import { OrganizationEntity } from '../organization/entities/organization.entity';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { UserEntity } from '../auth/entities/user.entity';

import { PolicyService } from './policy.service';
import { PolicyAccessGuard } from './guards/policy-access.guard';
import { PolicyController } from './policy.controller';

/**
 * Policy — the org rulebook. Defines work timing (clock-in/out), WFH and
 * work-location rules that Attendance resolves per employee. Org-scoped +
 * permission-gated (see PLAYBOOK.md). Exports PolicyService so Attendance can
 * resolve an employee's governing policy and Organization can seed the default.
 */
@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([
      PolicyEntity,
      PolicyAcknowledgementEntity,
      PolicyVersionEntity,
      OrganizationEntity,
      OrgMembershipEntity,
      UserEntity,
    ]),
  ],
  controllers: [PolicyController],
  providers: [PolicyService, PolicyAccessGuard],
  exports: [PolicyService],
})
export class PolicyModule {}
