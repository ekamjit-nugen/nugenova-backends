import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

/**
 * Guardian-access guard — guardian links and consent records are authored only by
 * the org's owner/admin (the registrar-facing surface), always within the JWT's
 * own org context. Mirrors AcademicAccessGuard / LmsAccessGuard. Must run AFTER
 * JwtAuthGuard (which populates `req.user`).
 *
 * The acting organization is ALWAYS the JWT's `organizationId`; routes never take
 * an org id from the client, so a token for org A can never touch org B's links
 * or consent ledger. A platform (super) admin is not an org member and is
 * rejected here.
 *
 * NOTE: a guardian-facing self-service portal (a guardian reading/consenting for
 * their own ward) is deferred — see PLAYBOOK "Deferred". Today these are admin
 * surfaces.
 */
@Injectable()
export class GuardianAccessGuard implements CanActivate {
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
