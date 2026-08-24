import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuditService } from './services/audit.service';
import { TokenRevocationService } from './services/token-revocation.service';
import { SessionSweepService } from './services/session-sweep.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PlatformAdminGuard } from './guards/platform-admin.guard';
import { AuthPublicApiImpl } from './public-api/auth-public-api.impl';
import { AUTH_PUBLIC_API } from './public-api/auth-public-api';

import { UserEntity } from './entities/user.entity';
import { OrgMembershipEntity } from './entities/org-membership.entity';
import { SessionEntity } from './entities/session.entity';
import { RoleEntity } from './entities/role.entity';
import { RevokedTokenEntity } from './entities/revoked-token.entity';
import { OrganizationEntity } from '../organization/entities/organization.entity';

/**
 * AuthModule — the first migrated module. Passwordless email-OTP login + TOTP
 * second factor + JWT issue/refresh/revoke on Postgres.
 *
 * Exports AuthService, the JWT machinery, TokenRevocationService and
 * AUTH_PUBLIC_API so later modules can protect routes (JwtAuthGuard) and resolve
 * identities without importing auth internals.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserEntity,
      OrgMembershipEntity,
      SessionEntity,
      RoleEntity,
      RevokedTokenEntity,
      OrganizationEntity,
    ]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => {
        const secret = cfg.get<string>('JWT_SECRET');
        if (!secret) throw new Error('FATAL: JWT_SECRET not configured');
        return { secret };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuditService,
    TokenRevocationService,
    SessionSweepService,
    JwtAuthGuard,
    PlatformAdminGuard,
    AuthPublicApiImpl,
    { provide: AUTH_PUBLIC_API, useExisting: AuthPublicApiImpl },
  ],
  exports: [
    AuthService,
    JwtModule,
    JwtAuthGuard,
    PlatformAdminGuard,
    TokenRevocationService,
    AUTH_PUBLIC_API,
    TypeOrmModule,
  ],
})
export class AuthModule {}
