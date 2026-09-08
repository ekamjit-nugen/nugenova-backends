import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

/**
 * Drive access-management guard — the admin surface (grant/revoke drive access,
 * per-user + org quotas). Mirrors the legacy `@Roles('admin', 'super_admin')`:
 * an org owner/admin OR a platform admin may manage their org's drive access.
 * Must run AFTER JwtAuthGuard. The acting org is always the JWT's own
 * `organizationId`, so a token for org A can never manage org B.
 */
@Injectable()
export class DriveAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const user = req.user;
    const ok =
      !!user &&
      (user.isPlatformAdmin === true ||
        user.orgRole === 'owner' ||
        user.orgRole === 'admin' ||
        (Array.isArray(user.roles) && user.roles.includes('super_admin')));
    if (!ok) throw new ForbiddenException('Cloud Drive admin access required');
    return true;
  }
}
