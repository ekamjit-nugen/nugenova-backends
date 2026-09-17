import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { NotificationModule } from '../notification/notification.module';
import { ClientsModule } from '../clients/clients.module';
import { VerticalModule } from '../vertical/vertical.module';
import { OrganizationEntity } from '../organization/entities/organization.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { ClientEntity } from '../clients/entities/client.entity';

import { PipelineStageEntity } from './entities/pipeline-stage.entity';
import { LeadEntity } from './entities/lead.entity';
import { SalesAccountEntity } from './entities/sales-account.entity';
import { SalesContactEntity } from './entities/sales-contact.entity';
import { SalesActivityEntity } from './entities/sales-activity.entity';
import { SalesFollowupEntity } from './entities/sales-followup.entity';
import { RequirementEntity } from './entities/requirement.entity';
import { QuoteEntity } from './entities/quote.entity';
import { LeadDocumentEntity } from './entities/lead-document.entity';
import { SalesService } from './sales.service';
import { SalesController } from './sales.controller';

/**
 * Sales & Leads — a lightweight CRM (Phase 1): pipeline stages, leads, accounts,
 * contacts, and a shared activity/follow-up timeline. Org-scoped.
 */
@Module({
  imports: [
    AuthModule,
    NotificationModule,
    ClientsModule,
    // ModuleEnabledGuard (the `sales` module gate) is provided by VerticalModule.
    VerticalModule,
    TypeOrmModule.forFeature([
      PipelineStageEntity,
      LeadEntity,
      SalesAccountEntity,
      SalesContactEntity,
      SalesActivityEntity,
      SalesFollowupEntity,
      RequirementEntity,
      QuoteEntity,
      LeadDocumentEntity,
      UserEntity,
      ClientEntity,
      // OrgAdminGuard reads the org to refuse suspended / terms-pending tenants.
      OrganizationEntity,
    ]),
  ],
  controllers: [SalesController],
  providers: [SalesService],
  exports: [SalesService],
})
export class SalesModule {}
