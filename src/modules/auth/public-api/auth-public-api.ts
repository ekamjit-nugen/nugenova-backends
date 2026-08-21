/**
 * AUTH_PUBLIC_API — the stable contract other modules depend on instead of
 * reaching into auth internals. Inject with `@Inject(AUTH_PUBLIC_API)`.
 */
export const AUTH_PUBLIC_API = Symbol('AUTH_PUBLIC_API');

export interface AuthPublicUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  roles: string[];
  isPlatformAdmin: boolean;
  setupStage: string;
  defaultOrganizationId: string | null;
}

export interface AuthPublicApi {
  /** Resolve a user by id, or null if absent. */
  getUserById(userId: string): Promise<AuthPublicUser | null>;
  /** Resolve a user by email (case-insensitive), or null. */
  getUserByEmail(email: string): Promise<AuthPublicUser | null>;
  /** True if the user holds platform-admin / super-admin rights. */
  isPlatformAdmin(userId: string): Promise<boolean>;
}
