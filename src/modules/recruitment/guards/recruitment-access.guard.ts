import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { OrganizationEntity } from '../../organization/entities/organization.entity';
import { TermsService } from '../../terms/terms.service';
import {
  REQUIRE_PERMISSION, RequiredPermission, permMapAllows,
} from '../../organization/guards/require-permission.decorator';

/**
 * Recruitment access guard — the org-scoped gate for `/recruitment/*`. Runs
 * AFTER JwtAuthGuard. Mirrors LeaveAccessGuard:
 *
 * 1. **Tenant isolation (fail-closed).** A JWT with no `organizationId`
 *    (platform super-admin) is rejected.
 * 2. **Lifecycle gate.** A suspended org, or one that hasn't accepted the current
 *    Terms, is blocked.
 * 3. **Authorization.** A route tagged `@RequirePermission('recruitment', …)`
 *    needs an owner/admin or a member whose role grants it. A route WITHOUT the
 *    decorator is the INTERVIEWER surface (my interviews, the interview detail,
 *    submitting my scorecard, the profile of a candidate I'm interviewing) —
 *    any active member reaches the handler, and the service enforces that they
 *    are actually assigned (404 otherwise).
 * 4. **Client portal users** (role `client`) never reach recruitment.
 */
@Injectable()
export class RecruitmentAccessGuard implements CanActivate {
  constructor(
    @InjectRepository(OrganizationEntity) private readonly orgRepo: Repository<OrganizationEntity>,
    private readonly terms: TermsService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const user = req.user;
    if (!user) throw new ForbiddenException('Not authenticated');
    const orgId = user.organizationId;
    if (!orgId) throw new ForbiddenException('No organization context on this session');
    if (user.orgRole === 'client') throw new ForbiddenException('Recruitment is not available to client users');

    const org = await this.orgRepo.findOne({ where: { id: orgId } });
    if (org) {
      if (org.status === 'suspended') {
        throw new ForbiddenException('Your organization has been suspended — please contact the platform administrator');
      }
      if (this.terms.needsConsentActive(org.consent)) {
        throw new ForbiddenException({ code: 'CONSENT_REQUIRED', message: 'Please review and accept the latest Terms & Conditions to continue' });
      }
    }

    const required = this.reflector.getAllAndOverride<RequiredPermission>(REQUIRE_PERMISSION, [context.getHandler(), context.getClass()]);
    if (!required) return true;
    const isOrgAdmin = user.orgRole === 'owner' || user.orgRole === 'admin';
    if (isOrgAdmin) return true;
    if (permMapAllows(user.perms, required.resource, required.action)) return true;
    throw new ForbiddenException(`You don't have permission to ${required.action} ${required.resource}`);
  }
}
