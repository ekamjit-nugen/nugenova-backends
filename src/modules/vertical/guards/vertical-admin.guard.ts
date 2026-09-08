import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

/**
 * Vertical-admin guard — an org's orgType/pack is set only by its owner/admin,
 * always within the JWT's own org context. Mirrors AcademicAccessGuard /
 * LmsAccessGuard. Must run AFTER JwtAuthGuard (which populates `req.user`).
 *
 * The acting organization is ALWAYS the JWT's `organizationId`; routes never take
 * an org id from the client, so a token for org A can never repack org B. A
 * platform (super) admin is not an org member and is rejected here.
 *
 * NOTE: the GET pack endpoint deliberately does NOT use this guard — resolving
 * one's own org vocabulary/modules is a read available to any authenticated
 * member of the org.
 */
@Injectable()
export class VerticalAdminGuard implements CanActivate {
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
