import { permMapAllows } from './require-permission.decorator';

/**
 * Pure unit specs for the backend permission-map check that OrgAdminGuard uses
 * to gate @RequirePermission routes. Mirrors the frontend `permMapAllows`.
 */
describe('permMapAllows (backend)', () => {
  it('always allows the self/dashboard resources', () => {
    expect(permMapAllows(null, 'dashboard', 'view')).toBe(true);
    expect(permMapAllows(null, 'self', 'edit')).toBe(true);
    expect(permMapAllows(undefined, '', 'view')).toBe(true);
  });

  it('denies everything when there is no permission map', () => {
    expect(permMapAllows(null, 'departments', 'view')).toBe(false);
    expect(permMapAllows(undefined, 'roles', 'view')).toBe(false);
  });

  it('grants exactly the resource:action pairs in the matrix', () => {
    const p = { departments: ['view'], roles: ['view', 'edit'] };
    expect(permMapAllows(p, 'departments', 'view')).toBe(true);
    expect(permMapAllows(p, 'departments', 'create')).toBe(false);
    expect(permMapAllows(p, 'roles', 'edit')).toBe(true);
    expect(permMapAllows(p, 'roles', 'delete')).toBe(false);
    expect(permMapAllows(p, 'employees', 'view')).toBe(false);
  });
});
