import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

/**
 * Roles allowed to read the org-wide AI usage ledger (`/ai/usage/events`,
 * `/ai/usage/by-user`, `/ai/usage/summary`). These surface every member's
 * prompts/outputs and per-user spend, so they are NOT a self-service or plain-
 * JWT surface — only the org's owner/admin and its HR manager may read them,
 * mirroring the admin dashboard's `owner/admin/hr` gate.
 */
export const AI_USAGE_READ_ROLES = ['owner', 'admin', 'hr'] as const;

/**
 * Gate for the AI usage READ endpoints. Runs AFTER JwtAuthGuard (which populates
 * `req.user`). Requires an org context and an `orgRole` in
 * {@link AI_USAGE_READ_ROLES}. `orgRole` is the membership role name set on the
 * JWT (see AuthService.buildTokens), never taken from the client.
 */
@Injectable()
export class AiUsageRoleGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const user = req.user;
    if (!user) throw new ForbiddenException('Not authenticated');
    if (!user.organizationId) {
      throw new ForbiddenException('No organization context on this session');
    }
    const role = String(user.orgRole || '');
    if (!(AI_USAGE_READ_ROLES as readonly string[]).includes(role)) {
      throw new ForbiddenException(
        'AI usage reporting is restricted to owner, admin and HR roles.',
      );
    }
    return true;
  }
}
