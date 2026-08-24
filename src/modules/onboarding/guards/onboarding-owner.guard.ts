import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

/**
 * Guards the owner-facing `/onboarding` surface. Unlike OrgAdminGuard this does
 * NOT require the org to be active — that surface exists precisely for orgs still
 * in `onboarding`. It only requires the session to be an owner/admin scoped to an
 * org. Must run AFTER JwtAuthGuard.
 */
@Injectable()
export class OnboardingOwnerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const user = req.user;
    if (!user) throw new ForbiddenException('Not authenticated');
    if (!user.organizationId) {
      throw new ForbiddenException('No organization context on this session');
    }
    const isOwnerOrAdmin =
      user.orgRole === 'owner' || user.orgRole === 'admin';
    if (!isOwnerOrAdmin) {
      throw new ForbiddenException('Only an organization owner can do this');
    }
    return true;
  }
}
