import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

/**
 * Org-admin guard — restricts org-setup routes to the owner/admin of the org the
 * JWT is scoped to. Must run AFTER JwtAuthGuard (which populates `req.user`).
 *
 * The acting organization is ALWAYS the JWT's `organizationId` — routes never
 * take an org id from the client, so a token for org A can't mutate org B.
 * Platform admins pass but still act within their token's org context.
 */
@Injectable()
export class OrgAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const user = req.user;
    if (!user) throw new ForbiddenException('Not authenticated');

    const orgId = user.organizationId;
    if (!orgId && !user.isPlatformAdmin) {
      throw new ForbiddenException('No organization context on this session');
    }

    const isOrgAdmin =
      user.orgRole === 'owner' ||
      user.orgRole === 'admin' ||
      user.isPlatformAdmin === true;
    if (!isOrgAdmin) {
      throw new ForbiddenException('Organization admin access required');
    }

    return true;
  }
}
