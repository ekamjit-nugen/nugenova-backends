import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { VendorEntity } from './entities/vendor.entity';
import { VendorContactEntity } from './entities/vendor-contact.entity';
import { VendorEmployeeEntity } from './entities/vendor-employee.entity';
import { VendorsService } from './vendors.service';
import { VendorsController } from './vendors.controller';

/**
 * Vendors — supplier companies, the people they supply, and our contacts there.
 * The buy side of Clients. Agreements, bills and the vendor portal follow in
 * later phases; they will hang off these three tables.
 */
@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([VendorEntity, VendorContactEntity, VendorEmployeeEntity])],
  controllers: [VendorsController],
  providers: [VendorsService],
  exports: [VendorsService],
})
export class VendorsModule {}
