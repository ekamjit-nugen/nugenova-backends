import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { OrganizationEntity } from '../entities/organization.entity';

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
 * The active-status gate is the second half of the onboarding approval flow: an
 * org still in `onboarding` (documents not yet all approved) cannot use the app —
 * its owner is confined to the `/onboarding` surface until a super admin approves
 * everything and the org flips to `active`.
 */
@Injectable()
export class OrgAdminGuard implements CanActivate {
  constructor(
    @InjectRepository(OrganizationEntity)
    private readonly orgRepo: Repository<OrganizationEntity>,
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
    if (org && org.status !== 'active') {
      throw new ForbiddenException(
        'Your organization is still being onboarded — complete document verification first',
      );
    }

    return true;
  }
}
