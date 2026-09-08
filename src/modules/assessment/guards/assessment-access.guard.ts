import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

/**
 * Assessment-access guard — assessments and marks are AUTHORED only by the org's
 * owner/admin, always within the JWT's own org context. Mirrors LmsAccessGuard.
 * Must run AFTER JwtAuthGuard (which populates `req.user`).
 *
 * The acting organization is ALWAYS the JWT's `organizationId`; routes never take
 * an org id from the client, so a token for org A can never touch org B's
 * gradebook. A platform (super) admin is not an org member and is rejected here.
 *
 * NOTE: the read surfaces — class gradebook and student report — deliberately do
 * NOT use this guard. They are teacher/admin-facing reads whose access
 * (owner/admin OR the class's assigned teacher) is decided inside
 * AssessmentService, exactly as the lms roster is.
 */
@Injectable()
export class AssessmentAccessGuard implements CanActivate {
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
