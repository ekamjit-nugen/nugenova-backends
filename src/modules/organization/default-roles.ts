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
  'expenses', 'clients', 'recruitment',
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
 * locked; Manager/Employee start empty (self-service) and are editable so an
 * org can grant them whatever it wants.
 *
 * Manager and Employee are load-bearing even when nobody is assigned them
 * directly: they are what a member falls back to when invited without a custom
 * role, or when their custom role is cleared (see MembershipService.resolveRole).
 */
export const SYSTEM_ROLES: SystemRoleDef[] = [
  { name: 'owner', displayName: 'Owner', description: 'Full access to everything in the organization.', tier: 'owner', permissions: FULL_ACCESS },
  { name: 'admin', displayName: 'Admin', description: 'Full administrative access.', tier: 'admin', permissions: FULL_ACCESS },
  { name: 'manager', displayName: 'Manager', description: 'Team lead — grant management permissions below as needed.', tier: 'manager', permissions: [] },
  { name: 'employee', displayName: 'Employee', description: 'Standard team member — self-service access.', tier: 'employee', permissions: [] },
];

/**
 * Built-ins that were removed: Member and Viewer. No membership in any org ever
 * held them and nothing assigned their tiers, so they only cluttered the Roles
 * page (their rows are retired by migration 1788490000000). The names stay
 * reserved so a custom role can't reuse them and look like the old built-in.
 *
 * Note the `viewer` TIER is still valid — the education pack's Student and
 * Guardian roles map to it on their own rows. Only the system ROLE is gone.
 */
export const RETIRED_SYSTEM_ROLE_NAMES = new Set(['member', 'viewer']);

/** The set of system-role slugs (used to protect them from deletion). */
export const SYSTEM_ROLE_NAMES = new Set(SYSTEM_ROLES.map((r) => r.name));
/** Names a custom role may not take: current built-ins plus retired ones. */
export const RESERVED_ROLE_NAMES = new Set([...SYSTEM_ROLE_NAMES, ...RETIRED_SYSTEM_ROLE_NAMES]);
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
      { resource: 'recruitment', actions: [...ALL] },
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

// ─────────────────────────────────────────────────────────────────────────────
// EDUCATION VERTICAL (§04/§12)
//
// The education pack seeds its own roles + resource keys REUSING the same
// role-matrix mechanism (RoleEntity + {resource, actions[]} permissions) — the
// matrix ENGINE is untouched; these are just additional data-driven definitions.
// They are NOT part of SYSTEM_ROLES/DEFAULT_ROLES (which every org gets), so a
// company tenant is unaffected; VerticalPackService seeds these only for an
// education orgType. Enforced tiers reuse the existing enum: institution leaders
// map to 'admin', operational staff to 'manager', teachers/individual staff to
// 'employee', and learner/guardian personas to 'viewer' (self-service, minimal).
// ─────────────────────────────────────────────────────────────────────────────

/** Education permission resources (keep in sync with the education Roles matrix). */
export const EDUCATION_RESOURCES = [
  'students',
  'guardians',
  'admissions',
  'courses',
  'classes',
  'enrolments',
  'attendance',
  'gradebook',
  'timetable',
  'fees',
  'library',
  'hostel',
  'transport',
  'reports',
  'settings',
] as const;

const EDU_FULL = EDUCATION_RESOURCES.map((r) => ({ resource: r, actions: [...ALL] }));
const eduView = (resources: string[]) =>
  resources.map((r) => ({ resource: r, actions: ['view'] }));

/**
 * Education system roles. `tier` is the enforced enum tier a holder receives;
 * `permissions` is the fine-grained matrix. Seeded by VerticalPackService for
 * education orgs (idempotent), never by the default org seeding.
 */
export const EDUCATION_ROLES: SystemRoleDef[] = [
  {
    name: 'principal',
    displayName: 'Principal',
    description: 'Head of the institution — full academic and operational access.',
    tier: 'admin',
    permissions: EDU_FULL,
  },
  {
    name: 'registrar',
    displayName: 'Registrar',
    description: 'Admissions, enrolment and student records.',
    tier: 'manager',
    permissions: [
      { resource: 'students', actions: [...ALL] },
      { resource: 'guardians', actions: [...ALL] },
      { resource: 'admissions', actions: [...ALL] },
      { resource: 'enrolments', actions: [...ALL] },
      { resource: 'courses', actions: ['view'] },
      { resource: 'classes', actions: ['view'] },
      { resource: 'reports', actions: ['view', 'export'] },
    ],
  },
  {
    name: 'hod',
    displayName: 'Head of Department',
    description: 'Leads a faculty/department — courses, classes and its teachers.',
    tier: 'manager',
    permissions: [
      { resource: 'courses', actions: [...ALL] },
      { resource: 'classes', actions: [...ALL] },
      { resource: 'enrolments', actions: ['view', 'create', 'edit'] },
      { resource: 'gradebook', actions: ['view', 'export'] },
      { resource: 'timetable', actions: [...ALL] },
      { resource: 'students', actions: ['view'] },
      { resource: 'reports', actions: ['view', 'export'] },
    ],
  },
  {
    name: 'teacher',
    displayName: 'Teacher',
    description: 'Teaches classes — marks attendance and grades their own students.',
    tier: 'employee',
    permissions: [
      // Scoped in-service to the teacher's own classes (the roster guard); the
      // matrix grants the capability, not org-wide reach.
      { resource: 'gradebook', actions: ['view', 'create', 'edit'] },
      { resource: 'timetable', actions: ['view'] },
      { resource: 'classes', actions: ['view'] },
      { resource: 'students', actions: ['view'] },
    ],
  },
  {
    name: 'counsellor',
    displayName: 'Counsellor',
    description: 'Student wellbeing and guidance.',
    tier: 'employee',
    permissions: [
      { resource: 'students', actions: ['view', 'edit'] },
      { resource: 'guardians', actions: ['view'] },
      { resource: 'attendance', actions: ['view'] },
      { resource: 'reports', actions: ['view'] },
    ],
  },
  {
    name: 'warden',
    displayName: 'Warden',
    description: 'Hostel/boarding operations.',
    tier: 'manager',
    permissions: [
      { resource: 'hostel', actions: [...ALL] },
      { resource: 'students', actions: ['view'] },
      { resource: 'guardians', actions: ['view'] },
      { resource: 'attendance', actions: ['view'] },
    ],
  },
  {
    name: 'librarian',
    displayName: 'Librarian',
    description: 'Library catalogue and lending.',
    tier: 'employee',
    permissions: [
      { resource: 'library', actions: [...ALL] },
      { resource: 'students', actions: ['view'] },
    ],
  },
  {
    name: 'accountant',
    displayName: 'Accountant',
    description: 'Fees, invoicing and financial reporting.',
    tier: 'manager',
    permissions: [
      { resource: 'fees', actions: [...ALL] },
      { resource: 'students', actions: ['view'] },
      { resource: 'guardians', actions: ['view'] },
      { resource: 'reports', actions: ['view', 'export'] },
    ],
  },
  {
    name: 'student',
    displayName: 'Student',
    description: 'A learner — self-service access to their own academic surfaces.',
    tier: 'viewer',
    // Self-service surfaces (own timetable/gradebook/fees) need no org-wide
    // permission; a Student role carries only read on shared catalogues.
    permissions: eduView(['courses', 'classes', 'library']),
  },
  {
    name: 'guardian',
    displayName: 'Guardian',
    description: "A parent/guardian — consent-gated view of their child's records.",
    tier: 'viewer',
    // A guardian's reach is decided per-link + consent (see the guardian module),
    // not by an org-wide matrix; this role is the minimal shell.
    permissions: eduView(['fees']),
  },
];

/** The set of education-role slugs (used to protect + detect them). */
export const EDUCATION_ROLE_NAMES = new Set(EDUCATION_ROLES.map((r) => r.name));
