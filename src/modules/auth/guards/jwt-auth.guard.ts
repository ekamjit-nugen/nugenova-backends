import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { TokenRevocationService } from '../services/token-revocation.service';

/**
 * JWT auth guard — verifies a Bearer token (or the `nugenova_token` cookie),
 * rejects revoked jti / mfa-challenge tokens, and attaches the decoded identity
 * to `req.user`. A lightweight replacement for the monolith's passport-jwt
 * strategy (the new repo has no passport dependency).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly tokenRevocation: TokenRevocationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const token = this.extractToken(req);
    if (!token) throw new UnauthorizedException('JWT token is missing');

    let payload: any;
    try {
      payload = this.jwtService.verify(token);
    } catch (err: any) {
      const reason = err?.message || 'invalid token';
      throw new UnauthorizedException(
        reason === 'jwt expired'
          ? 'Session expired — please log in again'
          : 'Invalid session — please log in again',
      );
    }

    // A meeting/mfa-challenge/guest token must never authenticate a REST request.
    if (payload.guest || payload.purpose) {
      throw new UnauthorizedException('Invalid token for this request');
    }
    if (!payload.sub || !payload.email) {
      throw new UnauthorizedException('Invalid JWT payload');
    }
    if (payload.jti && (await this.tokenRevocation.isRevoked(payload.jti))) {
      throw new UnauthorizedException('Session revoked — please log in again');
    }

    req.user = {
      userId: payload.sub,
      email: payload.email,
      firstName: payload.firstName,
      lastName: payload.lastName,
      roles: payload.roles,
      orgRole: payload.orgRole || null,
      orgRoleName: payload.orgRoleName || null,
      departmentScopeId: payload.departmentScopeId || null,
      clientId: payload.clientId || null,
      vendorId: payload.vendorId || null,
      vendorEmployeeId: payload.vendorEmployeeId || null,
      organizationId: payload.organizationId || null,
      perms: payload.perms || null,
      permScoped: payload.permScoped || false,
      isPlatformAdmin: payload.isPlatformAdmin || false,
      family: payload.family || null,
      jti: payload.jti || null,
      exp: payload.exp || null,
    };
    return true;
  }

  private extractToken(request: any): string | null {
    const authHeader = request.headers?.authorization;
    if (authHeader) {
      const parts = authHeader.split(' ');
      if (parts.length === 2 && parts[0] === 'Bearer') return parts[1];
    }
    if (request.cookies?.nugenova_token) return request.cookies.nugenova_token;
    return null;
  }
}
