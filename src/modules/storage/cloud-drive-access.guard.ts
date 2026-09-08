import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { DriveService } from './drive.service';

/**
 * Gates authenticated Cloud Drive routes on the per-user grant (Postgres port of
 * the legacy `cloud-drive-access.guard`).
 *
 * Runs AFTER JwtAuthGuard (so `req.user` is populated). Admins, owners and
 * platform-admins always pass — they manage access — while ordinary members need
 * `OrgMembership.cloudDrive.enabled`. On failure the service throws a 403 with
 * the stable code CLOUD_DRIVE_NO_ACCESS, which the frontend detects to show a
 * friendly "ask your admin" state.
 */
@Injectable()
export class CloudDriveAccessGuard implements CanActivate {
  constructor(private readonly drive: DriveService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const user = req.user;
    await this.drive.assertCanUseCloudDrive(
      user.organizationId,
      user.userId,
      user.orgRole,
      user.isPlatformAdmin,
    );
    return true;
  }
}
