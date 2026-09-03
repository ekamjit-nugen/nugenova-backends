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

/** Tiers that manage employee onboarding out of the box (legacy PRIVILEGED_ROLES). */
const PRIVILEGED_TIERS = ['owner', 'admin', 'hr'];

/**
 * Access gate for the HR-facing onboarding-lifecycle surface. Runs AFTER
 * JwtAuthGuard. Mirrors PolicyAccessGuard:
 *  1. Fail-closed on missing org (a platform super-admin has no org → 403).
 *  2. Lifecycle gate (suspended / consent-pending orgs blocked).
 *  3. A route tagged `@RequirePermission('employees', action)` is reachable by
 *     an owner/admin/HR tier OR a permScoped role granting the people-management
 *     permission (`employees:edit`). A route WITHOUT the decorator stays
 *     privileged-tier-only.
 */
@Injectable()
export class OnboardingAccessGuard implements CanActivate {
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
        throw new ForbiddenException({
          code: 'CONSENT_REQUIRED',
          message: 'Please review and accept the latest Terms & Conditions to continue',
        });
      }
    }

    const isPrivileged = PRIVILEGED_TIERS.includes(user.orgRole);
    if (isPrivileged) return true;

    const required = this.reflector.getAllAndOverride<RequiredPermission>(
      REQUIRE_PERMISSION,
      [context.getHandler(), context.getClass()],
    );
    if (required && permMapAllows(user.perms, required.resource, required.action)) {
      return true;
    }
    throw new ForbiddenException(
      'You do not have permission to manage onboarding',
    );
  }
}
