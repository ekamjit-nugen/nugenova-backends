import { DEFAULT_ROLES } from './default-roles';

/**
 * Guards the fix for the cross-employee attendance exposure (H1): because
 * clock-in / "my attendance" are self-service (ungated), the ONLY meaning of
 * `attendance:view` in the permission matrix is the ORG-WIDE roster/activity/
 * approvals. So an IC-tier default role must never carry it — otherwise every
 * developer/designer could read the whole org's attendance.
 */
describe('default roles — attendance exposure guard', () => {
  const byName = (n: string) => DEFAULT_ROLES.find((r) => r.name === n)!;
  const grants = (roleName: string, resource: string, action: string) => {
    const role = byName(roleName);
    const entry = role.permissions.find((p) => p.resource === resource);
    return !!entry && entry.actions.includes(action);
  };

  it('the IC roles (developer, designer) do NOT grant org-wide attendance:view', () => {
    expect(grants('developer', 'attendance', 'view')).toBe(false);
    expect(grants('designer', 'attendance', 'view')).toBe(false);
  });

  it('the HR role DOES manage org attendance (that is its job)', () => {
    expect(grants('hr', 'attendance', 'view')).toBe(true);
    expect(grants('hr', 'attendance', 'edit')).toBe(true);
  });

  it('IC roles keep their own task/project scope', () => {
    expect(grants('developer', 'tasks', 'view')).toBe(true);
    expect(grants('designer', 'projects', 'view')).toBe(true);
  });
});
