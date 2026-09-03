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
 * Policy access guard — the org-scoped gate for `/policies/*`. Runs AFTER
 * JwtAuthGuard. Same model as attendance:
 *  1. Fail-closed on missing org (a platform super-admin has no org → 403;
 *     they manage tenants via /admin/*). Closes the monolith's cross-org leaks.
 *  2. Lifecycle gate (suspended / consent-pending orgs blocked).
 *  3. A route tagged `@RequirePermission('policies', action)` needs owner/admin
 *     or a permScoped role granting it (authoring). A route WITHOUT it is a READ
 *     (list / view / applicable / acknowledge) — any active member, since every
 *     employee may read and acknowledge policies.
 */
@Injectable()
export class PolicyAccessGuard implements CanActivate {
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
    if (!orgId) throw new ForbiddenException('No organization context on this session');

    const org = await this.orgRepo.findOne({ where: { id: orgId } });
    if (org) {
      if (org.status === 'suspended') {
        throw new ForbiddenException(
          'Your organization has been suspended — please contact the platform administrator',
        );
      }
      if (this.terms.needsConsentActive(org.consent)) {
        throw new ForbiddenException(
          'Please review and accept the latest Terms & Conditions to continue',
        );
      }
    }

    const required = this.reflector.getAllAndOverride<RequiredPermission>(
      REQUIRE_PERMISSION,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true; // reads: any active member

    const isOrgAdmin = user.orgRole === 'owner' || user.orgRole === 'admin';
    if (isOrgAdmin) return true;
    if (permMapAllows(user.perms, required.resource, required.action)) return true;
    throw new ForbiddenException(
      `You don't have permission to ${required.action} ${required.resource}`,
    );
  }
}
