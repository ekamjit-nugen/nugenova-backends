/**
 * Default org roles, ported from the legacy Nugenova `seedDefaultRoles`. In the
 * Postgres model the standard tiers (owner/admin/manager/employee) are enforced
 * ENUM tiers and carry NO `roles` row — "the tier IS the role" (see
 * RoleEntity). So we seed only the extra, permission-bearing roles the old app
 * had beyond those tiers — HR, Developer, Designer — as real Role rows. Together
 * with the tiers this reproduces the legacy default set (owner, admin, hr,
 * manager, developer, designer, employee).
 *
 * Each carries `tier`: the enforced tier a member gets when assigned this custom
 * role (the coarse gate), while `permissions` drives fine-grained UI access.
 * Seeded org-wide (no departmentId); the owner can scope custom roles to a
 * department later — the department↔role relation lives on Role.departmentId.
 */
export interface DefaultRoleDef {
  name: string;
  displayName: string;
  description: string;
  /** Enforced tier this role maps to (owner|admin|manager|employee). */
  tier: 'manager' | 'employee';
  permissions: Array<{ resource: string; actions: string[] }>;
}

const ALL = ['view', 'create', 'edit', 'delete', 'export', 'assign'];

export const DEFAULT_ROLES: DefaultRoleDef[] = [
  {
    name: 'hr',
    displayName: 'HR Manager',
    description: 'Manage employees, attendance, leaves, and policies',
    tier: 'manager',
    permissions: [
      { resource: 'employees', actions: [...ALL] },
      { resource: 'attendance', actions: [...ALL] },
      { resource: 'leaves', actions: [...ALL] },
      { resource: 'departments', actions: [...ALL] },
      { resource: 'policies', actions: [...ALL] },
      { resource: 'reports', actions: ['view', 'export'] },
      { resource: 'settings', actions: ['view', 'edit'] },
      { resource: 'projects', actions: ['view'] },
      { resource: 'tasks', actions: ['view'] },
      { resource: 'roles', actions: ['view'] },
      { resource: 'invoices', actions: ['view'] },
      { resource: 'expenses', actions: ['view'] },
      { resource: 'clients', actions: ['view'] },
    ],
  },
  {
    name: 'developer',
    displayName: 'Developer',
    description: 'Work on tasks, log time, and manage own attendance',
    tier: 'employee',
    permissions: [
      { resource: 'tasks', actions: ['view', 'create', 'edit', 'export'] },
      { resource: 'projects', actions: ['view'] },
      { resource: 'attendance', actions: ['view', 'create'] },
      { resource: 'leaves', actions: ['view', 'create'] },
      { resource: 'reports', actions: ['view'] },
    ],
  },
  {
    name: 'designer',
    displayName: 'Designer',
    description: 'Work on tasks, log time, and manage own attendance',
    tier: 'employee',
    permissions: [
      { resource: 'tasks', actions: ['view', 'create', 'edit', 'export'] },
      { resource: 'projects', actions: ['view'] },
      { resource: 'attendance', actions: ['view', 'create'] },
      { resource: 'leaves', actions: ['view', 'create'] },
      { resource: 'reports', actions: ['view'] },
    ],
  },
];

/** Quick lookup: role name → the enforced tier a holder receives. */
export const ROLE_NAME_TO_TIER: Record<string, 'manager' | 'employee'> =
  Object.fromEntries(DEFAULT_ROLES.map((r) => [r.name, r.tier]));
