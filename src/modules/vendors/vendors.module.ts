import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { VendorEntity } from './entities/vendor.entity';
import { VendorContactEntity } from './entities/vendor-contact.entity';
import { VendorEmployeeEntity } from './entities/vendor-employee.entity';
import { VendorAgreementEntity } from './entities/vendor-agreement.entity';
import { VendorAgreementTemplateEntity } from './entities/vendor-agreement-template.entity';
import { VendorsService } from './vendors.service';
import { VendorAgreementsService } from './vendor-agreements.service';
import { VendorsController } from './vendors.controller';

/**
 * Vendors — supplier companies, the people they supply, our contacts there, and
 * the agreements they sign (with the clearance those agreements decide). The buy
 * side of Clients. Bills and the vendor portal follow in later phases.
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
    ]),
  ],
  controllers: [VendorsController],
  providers: [VendorsService, VendorAgreementsService],
  exports: [VendorsService, VendorAgreementsService],
})
export class VendorsModule {}
