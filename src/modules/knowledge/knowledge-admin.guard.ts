import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

/**
 * Admin gate for the knowledge backfill/status surface (`/ai/knowledge/*`).
 * Mirrors DriveAdminGuard: an org owner/admin or a platform admin may (re)index
 * or inspect the org corpus. Runs AFTER JwtAuthGuard; the acting org is always
 * the JWT's own `organizationId`, so a token for org A can never index org B.
 */
@Injectable()
export class KnowledgeAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const user = req.user;
    const ok =
      !!user &&
      (user.isPlatformAdmin === true ||
        user.orgRole === 'owner' ||
        user.orgRole === 'admin' ||
        (Array.isArray(user.roles) && user.roles.includes('super_admin')));
    if (!ok) throw new ForbiddenException('Knowledge admin access required');
    return true;
  }
}
