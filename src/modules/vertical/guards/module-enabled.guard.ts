import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { VerticalPackService } from '../vertical-pack.service';

export const REQUIRED_MODULE_KEY = 'requiredModule';

/**
 * Gate a controller/handler on a per-org module being enabled. Pair with
 * {@link ModuleEnabledGuard}. Opt-in by default: an org that has never had its
 * module list configured keeps access to everything (see
 * {@link VerticalPackService.isModuleAllowed}); a super admin enables/disables
 * the module from the platform org page.
 */
export const RequireModule = (moduleKey: string) => SetMetadata(REQUIRED_MODULE_KEY, moduleKey);

@Injectable()
export class ModuleEnabledGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly vertical: VerticalPackService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const moduleKey = this.reflector.getAllAndOverride<string | undefined>(REQUIRED_MODULE_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!moduleKey) return true; // no gate declared

    const req = ctx.switchToHttp().getRequest();
    const user = req.user;
    // Platform admins have no org context; org-less requests can't be gated.
    if (!user || user.isPlatformAdmin || !user.organizationId) return true;

    const allowed = await this.vertical.isModuleAllowed(user.organizationId, moduleKey);
    if (!allowed) {
      throw new ForbiddenException(`The "${moduleKey}" module is not enabled for your organization.`);
    }
    return true;
  }
}
