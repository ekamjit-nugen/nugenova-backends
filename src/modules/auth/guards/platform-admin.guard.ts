import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

/**
 * Restricts a route to platform (super) admins. Must run AFTER JwtAuthGuard,
 * which populates `req.user`. Accepts either the `isPlatformAdmin` flag or the
 * `super_admin` role for parity with how the token is minted.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const user = req.user;
    const ok =
      !!user &&
      (user.isPlatformAdmin === true ||
        (Array.isArray(user.roles) && user.roles.includes('super_admin')));
    if (!ok) throw new ForbiddenException('Platform admin access required');
    return true;
  }
}
