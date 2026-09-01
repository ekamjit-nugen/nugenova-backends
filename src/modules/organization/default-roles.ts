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

export interface SystemRoleDef {
  name: string;
  displayName: string;
  description: string;
  tier: string;
  permissions: Array<{ resource: string; actions: string[] }>;
}

const ALL = ['view', 'create', 'edit', 'delete', 'export', 'assign'];

/** Every permission resource in the product (keep in sync with the frontend
 *  Roles matrix `SECTIONS` + `RESOURCE_LABELS`). */
const ALL_RESOURCES = [
  'dashboard', 'employees', 'departments', 'roles', 'attendance', 'leaves',
  'payroll', 'policies', 'reports', 'settings', 'projects', 'tasks', 'invoices',
  'expenses', 'clients',
];

/** Full access — every resource × every action, so the Owner/Admin matrix shows
 *  fully-granted on the Roles page (their effective access is the org-admin gate;
 *  this matrix makes that access explicit and visible). */
const FULL_ACCESS = ALL_RESOURCES.map((r) => ({ resource: r, actions: [...ALL] }));

/**
 * The standard tiers as REAL, seeded role rows (one set per org). Previously
 * these lived only as an enum on the membership and never appeared on the Roles
 * page — now every member holds one of these (or a custom role) via `roleId`, so
 * roles are entirely data-driven and visible. Owner/Admin are full-access and
 * locked; Manager/Employee/Member/Viewer start empty (self-service) and are
 * editable so an org can grant them whatever it wants.
 */
export const SYSTEM_ROLES: SystemRoleDef[] = [
  { name: 'owner', displayName: 'Owner', description: 'Full access to everything in the organization.', tier: 'owner', permissions: FULL_ACCESS },
  { name: 'admin', displayName: 'Admin', description: 'Full administrative access.', tier: 'admin', permissions: FULL_ACCESS },
  { name: 'manager', displayName: 'Manager', description: 'Team lead — grant management permissions below as needed.', tier: 'manager', permissions: [] },
  { name: 'employee', displayName: 'Employee', description: 'Standard team member — self-service access.', tier: 'employee', permissions: [] },
  { name: 'member', displayName: 'Member', description: 'Basic member — self-service access.', tier: 'member', permissions: [] },
  { name: 'viewer', displayName: 'Viewer', description: 'Read-only member.', tier: 'viewer', permissions: [] },
];

/** The set of system-role slugs (used to protect them from deletion). */
export const SYSTEM_ROLE_NAMES = new Set(SYSTEM_ROLES.map((r) => r.name));
/** Owner/Admin are full-access and locked from editing (would risk a lockout). */
export const LOCKED_SYSTEM_ROLE_NAMES = new Set(['owner', 'admin']);

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
      { resource: 'payroll', actions: [...ALL] },
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
    description: 'Work on tasks and log time',
    tier: 'employee',
    permissions: [
      { resource: 'tasks', actions: ['view', 'create', 'edit', 'export'] },
      { resource: 'projects', actions: ['view'] },
      // NB: clock-in/out and "my attendance" are self-service (need NO
      // permission), so an IC role must NOT carry `attendance:view` — in the
      // permission matrix that grants the ORG-WIDE roster/activity/approvals,
      // not "view my own". Same logic will apply to `leaves` once it migrates.
      { resource: 'reports', actions: ['view'] },
    ],
  },
  {
    name: 'designer',
    displayName: 'Designer',
    description: 'Work on tasks and log time',
    tier: 'employee',
    permissions: [
      { resource: 'tasks', actions: ['view', 'create', 'edit', 'export'] },
      { resource: 'projects', actions: ['view'] },
      // See the developer note: self-service attendance needs no permission;
      // `attendance:view` would grant org-wide access, so ICs don't get it.
      { resource: 'reports', actions: ['view'] },
    ],
  },
];

/** Quick lookup: role name → the enforced tier a holder receives. */
export const ROLE_NAME_TO_TIER: Record<string, 'manager' | 'employee'> =
  Object.fromEntries(DEFAULT_ROLES.map((r) => [r.name, r.tier]));
