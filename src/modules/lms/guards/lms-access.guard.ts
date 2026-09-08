import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

/**
 * LMS-access guard — courses, class/sections and enrolments are AUTHORED only by
 * the org's owner/admin, always within the JWT's own org context. Mirrors
 * AcademicAccessGuard. Must run AFTER JwtAuthGuard (which populates `req.user`).
 *
 * The acting organization is ALWAYS the JWT's `organizationId`; routes never take
 * an org id from the client, so a token for org A can never touch org B's LMS
 * data. A platform (super) admin is not an org member and is rejected here.
 *
 * NOTE: the student roster endpoint deliberately does NOT use this guard — it is
 * a teacher/admin-facing read whose access (owner/admin OR the class's assigned
 * teacher) is decided inside LmsService, so a teacher who is not an org admin can
 * still read their own class roster.
 */
@Injectable()
export class LmsAccessGuard implements CanActivate {
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
