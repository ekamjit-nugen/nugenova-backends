import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PlatformTermsEntity } from './entities/platform-terms.entity';
import { TermsService } from './terms.service';

/**
 * Global Terms & Conditions. Exposed globally so the auth routing and the org
 * guards can read the current terms version to enforce the consent gate without
 * importing the organization module.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([PlatformTermsEntity])],
  providers: [TermsService],
  exports: [TermsService, TypeOrmModule],
})
export class TermsModule {}
