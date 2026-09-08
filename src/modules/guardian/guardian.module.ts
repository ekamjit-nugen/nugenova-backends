import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { GuardianLinkEntity } from './entities/guardian-link.entity';
import { ConsentLedgerEntity } from './entities/consent-ledger.entity';
import { GuardianService } from './guardian.service';
import { GuardianAccessGuard } from './guards/guardian-access.guard';
import { GuardianController } from './guardian.controller';

/**
 * Guardian — the guardian↔student graph and the per-learner consent ledger
 * (§04, §09/§10). Owner/admin authored, tenant-scoped. Imports AuthModule for
 * the JWT guard and reads OrgMembership to enforce the personType invariants
 * (guardian side must be a guardian, student side a student). Exports
 * GuardianService so §09's AI tiers can gate on `isConsented`. See PLAYBOOK.md.
 */
@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([
      GuardianLinkEntity,
      ConsentLedgerEntity,
      OrgMembershipEntity,
    ]),
  ],
  controllers: [GuardianController],
  providers: [GuardianService, GuardianAccessGuard],
  exports: [GuardianService],
})
export class GuardianModule {}
