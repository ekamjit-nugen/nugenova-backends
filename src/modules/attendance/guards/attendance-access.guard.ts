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
 * Attendance access guard — the org-scoped gate for `/attendance/*` + `/holidays`.
 * Runs AFTER JwtAuthGuard.
 *
 * 1. **Tenant isolation (fail-closed).** Access is by ORG MEMBERSHIP only. A JWT
 *    with no `organizationId` (a platform super-admin) is rejected — super
 *    admins manage tenants via `/admin/*` and must NOT read an org's attendance.
 *    This closes the monolith's null-org leak (`if (orgId)` scoping dropped the
 *    filter and returned every org's rows) by construction.
 * 2. **Lifecycle gate.** A suspended org, or one that hasn't accepted the current
 *    Terms, is blocked (its people are confined to /suspended or /consent).
 * 3. **Authorization.** A route tagged `@RequirePermission(resource, action)` is
 *    reachable by an owner/admin OR a permScoped member whose matrix grants it
 *    (the org-wide surfaces: list, activity, approvals, holiday writes). A route
 *    WITHOUT the decorator is the SELF-SERVICE surface (clock-in/out, my,
 *    today, manual-entry, request-edit) — reachable by ANY active member.
 */
@Injectable()
export class AttendanceAccessGuard implements CanActivate {
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

    // Lifecycle gate (applies to every org member).
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

    const required = this.reflector.getAllAndOverride<RequiredPermission>(
      REQUIRE_PERMISSION,
      [context.getHandler(), context.getClass()],
    );

    // No @RequirePermission → the self-service surface: any active member.
    if (!required) return true;

    const isOrgAdmin = user.orgRole === 'owner' || user.orgRole === 'admin';
    if (isOrgAdmin) return true;
    if (permMapAllows(user.perms, required.resource, required.action)) return true;
    throw new ForbiddenException(
      `You don't have permission to ${required.action} ${required.resource}`,
    );
  }
}
