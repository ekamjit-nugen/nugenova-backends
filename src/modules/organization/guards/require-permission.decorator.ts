import { SetMetadata } from '@nestjs/common';

export const REQUIRE_PERMISSION = 'require_permission';

export interface RequiredPermission {
  resource: string;
  action: string;
}

/**
 * Marks an org route as gated by a fine-grained permission rather than the
 * coarse owner/admin tier. A route WITHOUT this decorator stays owner/admin-only
 * (the setup-wizard surface); a route WITH it is reachable by an admin/owner OR
 * by a permScoped custom-role member whose matrix grants `resource:action`.
 * See `OrgAdminGuard`.
 */
export const RequirePermission = (resource: string, action: string) =>
  SetMetadata(REQUIRE_PERMISSION, { resource, action } as RequiredPermission);

/**
 * Does a JWT permission map grant `action` on `resource`? Mirrors the frontend
 * `permMapAllows`: `dashboard`/`self` are never locked; otherwise the matrix
 * must list the action for the resource.
 */
export function permMapAllows(
  perms: Record<string, string[]> | null | undefined,
  resource: string,
  action: string,
): boolean {
  if (!resource || resource === 'self' || resource === 'dashboard') return true;
  if (!perms) return false;
  const actions = perms[resource];
  return Array.isArray(actions) && actions.includes(action);
}
