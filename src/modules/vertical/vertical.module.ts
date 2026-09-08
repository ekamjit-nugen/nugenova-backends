import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { OrganizationEntity } from '../organization/entities/organization.entity';
import { RoleEntity } from '../auth/entities/role.entity';
import { VerticalPackService } from './vertical-pack.service';
import { VerticalAdminGuard } from './guards/vertical-admin.guard';
import { VerticalController } from './vertical.controller';

/**
 * Vertical — §04/§12. Resolves and mutates an org's vertical pack (orgType +
 * vocabulary/modules/AI-tier overrides) and seeds the education role set. Reads/
 * writes OrganizationEntity and RoleEntity (reusing the existing role matrix).
 * Imports AuthModule for the JWT guard. See PLAYBOOK.md.
 */
@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([OrganizationEntity, RoleEntity]),
  ],
  controllers: [VerticalController],
  providers: [VerticalPackService, VerticalAdminGuard],
  exports: [VerticalPackService],
})
export class VerticalModule {}
