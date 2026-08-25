import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { OrganizationEntity } from '../entities/organization.entity';
import { TermsService } from '../../terms/terms.service';

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
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const user = req.user;
    if (!user) throw new ForbiddenException('Not authenticated');

    if (user.isPlatformAdmin === true) return true;

    const orgId = user.organizationId;
    if (!orgId) {
      throw new ForbiddenException('No organization context on this session');
    }

    const isOrgAdmin = user.orgRole === 'owner' || user.orgRole === 'admin';
    if (!isOrgAdmin) {
      throw new ForbiddenException('Organization admin access required');
    }

    const org = await this.orgRepo.findOne({ where: { id: orgId } });
    if (org) {
      if (org.status === 'suspended') {
        throw new ForbiddenException(
          'Your organization has been suspended — please contact the platform administrator',
        );
      }
      const needsConsent = this.terms.needsConsent(org.termsId, org.consent);
      if (needsConsent) {
        throw new ForbiddenException(
          'Please review and accept the latest Terms & Conditions to continue',
        );
      }
    }

    return true;
  }
}
