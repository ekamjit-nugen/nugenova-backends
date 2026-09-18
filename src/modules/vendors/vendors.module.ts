import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { OrgMembershipEntity } from '../auth/entities/org-membership.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { VendorEntity } from './entities/vendor.entity';
import { VendorContactEntity } from './entities/vendor-contact.entity';
import { VendorEmployeeEntity } from './entities/vendor-employee.entity';
import { VendorAgreementEntity } from './entities/vendor-agreement.entity';
import { VendorAgreementTemplateEntity } from './entities/vendor-agreement-template.entity';
import { VendorBillEntity } from './entities/vendor-bill.entity';
import { VendorDocumentEntity } from './entities/vendor-document.entity';
import { VendorsService } from './vendors.service';
import { VendorAgreementsService } from './vendor-agreements.service';
import { VendorBillsService } from './vendor-bills.service';
import { VendorPortalService } from './vendor-portal.service';
import { VendorDocumentsService } from './vendor-documents.service';
import { VendorPortalController } from './vendor-portal.controller';
import { VendorsController } from './vendors.controller';

/**
 * Vendors — supplier companies, the people they supply, our contacts there, and
 * the agreements they sign (with the clearance those agreements decide), and the
 * bills they raise, and the portal their own people sign in to. The buy side of
 * Clients. The global MailModule supplies the portal invite mail.
 */
@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([
      VendorEntity,
      VendorContactEntity,
      VendorEmployeeEntity,
      VendorAgreementEntity,
      VendorAgreementTemplateEntity,
      VendorBillEntity,
      VendorDocumentEntity,
      OrgMembershipEntity,
      UserEntity,
    ]),
  ],
  controllers: [VendorsController, VendorPortalController],
  providers: [VendorsService, VendorAgreementsService, VendorBillsService, VendorDocumentsService, VendorPortalService],
  exports: [VendorsService, VendorAgreementsService, VendorBillsService, VendorDocumentsService, VendorPortalService],
})
export class VendorsModule {}
