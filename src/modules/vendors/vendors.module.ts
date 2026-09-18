import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { VendorEntity } from './entities/vendor.entity';
import { VendorContactEntity } from './entities/vendor-contact.entity';
import { VendorEmployeeEntity } from './entities/vendor-employee.entity';
import { VendorAgreementEntity } from './entities/vendor-agreement.entity';
import { VendorAgreementTemplateEntity } from './entities/vendor-agreement-template.entity';
import { VendorBillEntity } from './entities/vendor-bill.entity';
import { VendorsService } from './vendors.service';
import { VendorAgreementsService } from './vendor-agreements.service';
import { VendorBillsService } from './vendor-bills.service';
import { VendorsController } from './vendors.controller';

/**
 * Vendors — supplier companies, the people they supply, our contacts there, and
 * the agreements they sign (with the clearance those agreements decide), and the
 * bills they raise. The buy side of Clients; the vendor portal follows.
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
    ]),
  ],
  controllers: [VendorsController],
  providers: [VendorsService, VendorAgreementsService, VendorBillsService],
  exports: [VendorsService, VendorAgreementsService, VendorBillsService],
})
export class VendorsModule {}
