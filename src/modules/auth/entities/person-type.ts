import { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

/**
 * personType — the education-vertical guard for OrgMembership.
 *
 * The whole HR/payroll/attendance platform was built assuming every org member
 * is STAFF. Once the education vertical introduces STUDENT and GUARDIAN
 * memberships in the same `org_memberships` table, any staff-assuming query that
 * enumerates "employees/members" would silently sweep them in — generating
 * payslips for students, inflating seat counts, and adding students to the staff
 * attendance roster (the same class of defect as the past null-org attendance
 * leak). `staffScope()` makes that impossible by construction: it narrows a
 * membership query to `personType = 'staff'`.
 */
export type PersonType = 'staff' | 'student' | 'guardian';

/** Every allowed personType (validation + docs). */
export const PERSON_TYPES: readonly PersonType[] = ['staff', 'student', 'guardian'];

/** The default — every existing row and every new org member is staff. */
export const STAFF_PERSON_TYPE: PersonType = 'staff';

/**
 * Narrow a TypeORM `where` object (used with `.find` / `.findOne` / `.count`)
 * to staff-only memberships. Spread-merge so callers keep their own filters:
 *
 *   this.memberships.find({ where: staffScope({ organizationId, status: 'active' }) })
 *
 * Passing no argument yields `{ personType: 'staff' }` for a bare staff filter.
 */
export function staffScope<T extends ObjectLiteral>(
  where?: T,
): T & { personType: PersonType } {
  return { ...(where ?? ({} as T)), personType: STAFF_PERSON_TYPE };
}

/**
 * QueryBuilder variant of `staffScope` — appends `<alias>.personType = 'staff'`
 * to a `SelectQueryBuilder` over OrgMembership. Use where a query is built with
 * `.createQueryBuilder(alias)` rather than a `where` object.
 */
export function applyStaffScope<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  alias: string,
): SelectQueryBuilder<T> {
  return qb.andWhere(`${alias}.personType = :__staffPersonType`, {
    __staffPersonType: STAFF_PERSON_TYPE,
  });
}
