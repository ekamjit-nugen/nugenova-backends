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
 * Payroll access guard — the org-scoped gate for `/payroll/*`. Runs AFTER
 * JwtAuthGuard. Mirrors the leave/attendance guards: tenant isolation
 * (fail-closed on no org), lifecycle gate (suspended / unaccepted Terms), and
 * permission. Routes tagged `@RequirePermission('payroll', …)` need owner/admin
 * or a permScoped `payroll:*` role (the manager surface: salary editing, running
 * payslips, org-wide reads). Undecorated routes are SELF-SERVICE (my salary, my
 * payslips) — any active member.
 */
@Injectable()
export class PayrollAccessGuard implements CanActivate {
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
    if (!required) return true;

    const isOrgAdmin = user.orgRole === 'owner' || user.orgRole === 'admin';
    if (isOrgAdmin) return true;
    if (permMapAllows(user.perms, required.resource, required.action)) return true;
    throw new ForbiddenException(
      `You don't have permission to ${required.action} ${required.resource}`,
    );
  }
}
