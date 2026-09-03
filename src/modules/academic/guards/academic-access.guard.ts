import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

/**
 * Academic-access guard — the academic calendar (years + terms) is authored only
 * by the org's owner/admin, always within the JWT's own org context. Must run
 * AFTER JwtAuthGuard (which populates `req.user`).
 *
 * The acting organization is ALWAYS the JWT's `organizationId` — routes never
 * take an org id from the client, so a token for org A can never touch org B's
 * calendar. A platform (super) admin is NOT an org member and is rejected here;
 * they manage tenants through `/admin/*`, not an org's calendar.
 */
@Injectable()
export class AcademicAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const user = req.user;
    if (!user) throw new ForbiddenException('Not authenticated');
    if (!user.organizationId) {
      throw new ForbiddenException('No organization context on this session');
    }
    const isOrgAdmin = user.orgRole === 'owner' || user.orgRole === 'admin';
    if (!isOrgAdmin) {
      throw new ForbiddenException('Organization admin access required');
    }
    return true;
  }
}
