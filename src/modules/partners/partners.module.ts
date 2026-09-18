import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { PartnerEntity } from './entities/partner.entity';
import { ClientEntity } from '../clients/entities/client.entity';
import { VendorEntity } from '../vendors/entities/vendor.entity';
import { ClientContactEntity } from '../clients/entities/client-contact.entity';
import { ClientAssignmentEntity } from '../clients/entities/client-assignment.entity';
import { VendorContactEntity } from '../vendors/entities/vendor-contact.entity';
import { VendorEmployeeEntity } from '../vendors/entities/vendor-employee.entity';
import { PartnersService } from './partners.service';
import { PartnersController } from './partners.controller';

/**
 * Partners — the shared spine under clients and vendors. The two keep their own
 * modules for what differs (bills and supplied people on a vendor; tickets,
 * shared boards and a delivery team on a client); this is the combined record,
 * list and detail they sit on.
 */
@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([
      PartnerEntity,
      ClientEntity,
      VendorEntity,
      ClientContactEntity,
      ClientAssignmentEntity,
      VendorContactEntity,
      VendorEmployeeEntity,
    ]),
  ],
  controllers: [PartnersController],
  providers: [PartnersService],
  exports: [PartnersService],
})
export class PartnersModule {}
