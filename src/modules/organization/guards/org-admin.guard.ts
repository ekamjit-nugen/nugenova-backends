import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { OrganizationEntity } from '../entities/organization.entity';
import { TermsService } from '../../terms/terms.service';
import {
  REQUIRE_PERMISSION,
  RequiredPermission,
  permMapAllows,
} from './require-permission.decorator';

/**
 * Org-admin guard — restricts org-setup routes to the owner/admin of the org the
 * JWT is scoped to, AND only once that org is `active`. Must run AFTER
 * JwtAuthGuard (which populates `req.user`).
 *
 * The acting organization is ALWAYS the JWT's `organizationId` — routes never
 * take an org id from the client, so a token for org A can't mutate org B.
 * Platform admins pass (and skip the active-status gate) but still act within
 * their token's org context.
 *
 * The lifecycle gate: an org that is `suspended` (manually halted) or has not
 * accepted the CURRENT Terms & Conditions version cannot use `/org/*` — its owner
 * is confined to `/suspended` or `/consent` respectively until the halt is lifted
 * / the terms are accepted.
 */
@Injectable()
export class OrgAdminGuard implements CanActivate {
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

    // `/org/*` is a strictly org-scoped surface: access is by ORG MEMBERSHIP +
    // role, never by platform-admin. A platform (super) admin is NOT an org
    // member and must NOT read an org's departments/roles/members here — they
    // manage tenants through `/admin/*`. (Without this, a super admin whose JWT
    // carries no organizationId reached the services with a null org filter,
    // which TypeORM ignores → every org's rows leaked.)
    const orgId = user.organizationId;
    if (!orgId) {
      throw new ForbiddenException('No organization context on this session');
    }

    // Lifecycle gate (applies to every org member, admin or not): a suspended or
    // consent-pending org is confined to /suspended or /consent.
    const org = await this.orgRepo.findOne({ where: { id: orgId } });
    if (org) {
      if (org.status === 'suspended') {
        throw new ForbiddenException(
          'Your organization has been suspended — please contact the platform administrator',
        );
      }
      const needsConsent = this.terms.needsConsentActive(org.consent);
      if (needsConsent) {
        throw new ForbiddenException({
          code: 'CONSENT_REQUIRED',
          message: 'Please review and accept the latest Terms & Conditions to continue',
        });
      }
    }

    const isOrgAdmin = user.orgRole === 'owner' || user.orgRole === 'admin';

    // A route tagged with @RequirePermission is reachable by an admin/owner OR
    // by a permScoped custom-role member whose matrix grants resource:action.
    // A route WITHOUT it stays owner/admin-only (the setup-wizard surface).
    const required = this.reflector.getAllAndOverride<RequiredPermission>(
      REQUIRE_PERMISSION,
      [context.getHandler(), context.getClass()],
    );

    if (!required) {
      if (!isOrgAdmin) {
        throw new ForbiddenException('Organization admin access required');
      }
      return true;
    }

    if (isOrgAdmin) return true;
    if (permMapAllows(user.perms, required.resource, required.action)) {
      return true;
    }
    throw new ForbiddenException(
      `You don't have permission to ${required.action} ${required.resource}`,
    );
  }
}
