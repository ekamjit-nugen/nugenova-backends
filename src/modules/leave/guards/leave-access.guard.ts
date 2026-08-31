import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { OrganizationEntity } from '../../organization/entities/organization.entity';
import { TermsService } from '../../terms/terms.service';
import {
  REQUIRE_PERMISSION,
  RequiredPermission,
  permMapAllows,
} from '../../organization/guards/require-permission.decorator';

/**
 * Leave access guard — the org-scoped gate for `/leaves/*`. Runs AFTER
 * JwtAuthGuard. Mirrors AttendanceAccessGuard:
 *
 * 1. **Tenant isolation (fail-closed).** By ORG MEMBERSHIP only. A JWT with no
 *    `organizationId` (platform super-admin) is rejected — super admins don't
 *    read an org's leave.
 * 2. **Lifecycle gate.** Suspended org, or one that hasn't accepted current Terms,
 *    is blocked.
 * 3. **Authorization.** A route tagged `@RequirePermission('leaves', …)` needs an
 *    owner/admin OR a permScoped member whose matrix grants it (the manager
 *    surface: org-wide list, approvals, approve/reject, other users' balances).
 *    A route WITHOUT the decorator is SELF-SERVICE (apply, my leaves, my balance,
 *    cancel) — any active member.
 */
@Injectable()
export class LeaveAccessGuard implements CanActivate {
  constructor(
    @InjectRepository(OrganizationEntity)
    private readonly orgRepo: Repository<OrganizationEntity>,
    private readonly terms: TermsService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const user = req.user;
    if (!user) throw new ForbiddenException('Not authenticated');

    const orgId = user.organizationId;
    if (!orgId) {
      throw new ForbiddenException('No organization context on this session');
    }

    const org = await this.orgRepo.findOne({ where: { id: orgId } });
    if (org) {
      if (org.status === 'suspended') {
        throw new ForbiddenException(
          'Your organization has been suspended — please contact the platform administrator',
        );
      }
      if (this.terms.needsConsent(org.termsId, org.consent)) {
        throw new ForbiddenException(
          'Please review and accept the latest Terms & Conditions to continue',
        );
      }
    }

    const required = this.reflector.getAllAndOverride<RequiredPermission>(
      REQUIRE_PERMISSION,
      [context.getHandler(), context.getClass()],
    );

    // No @RequirePermission → self-service surface: any active member.
    if (!required) return true;

    const isOrgAdmin = user.orgRole === 'owner' || user.orgRole === 'admin';
    if (isOrgAdmin) return true;
    if (permMapAllows(user.perms, required.resource, required.action)) return true;
    throw new ForbiddenException(
      `You don't have permission to ${required.action} ${required.resource}`,
    );
  }
}
