import { Injectable } from '@nestjs/common';
import { AuthService } from '../auth.service';
import { AuthPublicApi, AuthPublicUser } from './auth-public-api';
import { UserEntity } from '../entities/user.entity';

@Injectable()
export class AuthPublicApiImpl implements AuthPublicApi {
  constructor(private readonly authService: AuthService) {}

  private toPublic(u: UserEntity): AuthPublicUser {
    return {
      id: u.id,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      roles: u.roles || [],
      isPlatformAdmin: !!u.isPlatformAdmin,
      setupStage: u.setupStage,
      defaultOrganizationId: u.defaultOrganizationId,
    };
  }

  async getUserById(userId: string): Promise<AuthPublicUser | null> {
    try {
      const u = await this.authService.getUserById(userId);
      return this.toPublic(u);
    } catch {
      return null;
    }
  }

  async getUserByEmail(email: string): Promise<AuthPublicUser | null> {
    const u = await this.authService.findUserByEmail(email);
    return u ? this.toPublic(u) : null;
  }

  async isPlatformAdmin(userId: string): Promise<boolean> {
    const u = await this.getUserById(userId);
    return !!u?.isPlatformAdmin || !!u?.roles?.includes('super_admin');
  }
}
