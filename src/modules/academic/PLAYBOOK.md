---
module: academic
title: Academic Calendar & the personType Guard
owner: education
status: live
phase: 0 (education-vertical foundation)
addedAt: 2026-09-03
---

# Academic Calendar & the `personType` Guard

The **P0 foundation** for extending Nexora into an education vertical. Two things
land here, both *before any student row exists*:

1. **`personType` on `org_memberships`** + the shared **`staffScope()`** guard —
   so students can never be swept into staff-only surfaces (payroll, attendance
   roster, seats, directory).
2. The **academic calendar** — `AcademicYear` + ordered `Term` — the future
   gradebook/enrolment anchor to the calendar from day one (retrofitting a
   calendar under existing marks is a rewrite, the same lesson as the attendance
   tz-day anchor).

No student-facing feature, enrolment, or course lives here yet — this is only the
ground the rest stands on.

## ⚠️ The `personType` guard — READ THIS BEFORE ADDING STUDENTS

Every HR/payroll/attendance module queries `org_memberships` **assuming the
person is staff**. Once STUDENT and GUARDIAN memberships share that table, any
staff-assuming enumeration that isn't scoped would:

- generate **payslips for students**,
- **inflate seat/billing counts**,
- put students in the **staff attendance roster** (the same class of defect as
  the past null-org attendance leak).

### The column

`OrgMembershipEntity.personType` — `varchar(16) NOT NULL DEFAULT 'staff'`,
allowed values `staff | student | guardian`. The default backfills every existing
row and every future member to `staff`; a person is only a student/guardian when
explicitly enrolled as one.

### The helper (`auth/entities/person-type.ts`)

```ts
// object-where form (.find / .findOne / .count)
this.memberships.find({ where: staffScope({ organizationId, status: 'active' }) });

// query-builder form
applyStaffScope(this.memberships.createQueryBuilder('m').where(...), 'm');
```

`staffScope()` appends `personType: 'staff'` **last**, so a caller can't
accidentally (or maliciously) widen it back to student.

### Rule for new education code

**Any query that means "the staff / employees / members of an org" MUST be
staff-scoped.** A query that legitimately targets a *specific* membership by id
(get / update / a person's own row) is fine unscoped. When you introduce
student/guardian listings, give them their **own** surfaces — never reuse the
staff directory or seat counts.

### Surfaces already gated (P0)

| File | Query | Why |
|------|-------|-----|
| `payroll/services/payroll.service.ts` → `setSalary` | membership lookup before creating a salary | the only entry point onto payroll — keeps students off the salaried roster by construction |
| `attendance/services/attendance-cron.service.ts` → `trackableMembers` | absence/nudge/digest roster | staff attendance only |
| `attendance/services/attendance.service.ts` → `departmentScopeIds` | a dept lead's visible team | staff team, not students in the dept |
| `organization/services/membership.service.ts` → `list` | the org directory (`GET /org/members`) | staff directory |
| `admin-platform/admin-platform.service.ts` → `getUsage` | per-org seats + total/active member counts | seats are a billing metric — staff only |
| `organization/services/organization.service.ts` → `getInsights` | account-level member counts + security signals | same seat/usage semantics as the platform overview |
| `notification/notifier.service.ts` → `resolveManagers` | approver/manager fan-out | approvers are staff |

`notifyOrgLeaders` (organization.service) is **intentionally left unscoped** — it
already filters `role ∈ {owner, admin}`, which a student/guardian can never hold.

Regression guards: the unit spec `auth/entities/person-type.spec.ts` fails the
build if the directory stops excluding non-staff; the e2e `academic.e2e-spec.ts`
inserts a real `student` membership and asserts it is absent from the directory
**and** from the seat count.

## Academic calendar

Base path `POST/GET/PUT/DELETE /api/v1/academic`. **Owner/admin only**
(`AcademicAccessGuard`), always scoped to the JWT's org — routes never take an
org id from the client, so org A can't touch org B's calendar.

### AcademicYear

`{ organizationId, name, startDate, endDate, isCurrent }`.

- **Exactly one current year per org.** Enforced by a **partial-unique index**
  (`WHERE is_current = true`) *and* the service, which clears the flag on every
  other year inside a transaction before setting the new one. Promote a year with
  `PUT /academic/years/:id/current` (or `isCurrent: true` on create/update).
- Unique year name per org.

### Term

`{ academicYearId, organizationId, name, startDate, endDate, sequence }`.

- **Ordered** by `sequence`, **unique within a year** (index +
  `uq_term_year_sequence`). Omit `sequence` on create and it auto-appends (max+1).
- Every date range is validated `start < end`, and **a term must fall within its
  year's bounds** — the calendar is internally consistent for the gradebook.

Deleting a year cascades its terms (safe now — no marks exist yet; revisit when
the gradebook lands).

## Routes

```
POST   /academic/years                     create year
GET    /academic/years                     list (newest first)
GET    /academic/years/current             the org's current year (or null)
GET    /academic/years/:yearId             one year
PUT    /academic/years/:yearId             update (name/dates/isCurrent→true)
PUT    /academic/years/:yearId/current     make this the current year
DELETE /academic/years/:yearId             delete year + its terms
POST   /academic/years/:yearId/terms       create term (sequence auto-appends)
GET    /academic/years/:yearId/terms       list terms (sequence order)
PUT    /academic/years/:yearId/terms/:id   update term
DELETE /academic/years/:yearId/terms/:id   delete term
```

## Tests

- `academic.service.spec.ts` — date validation, one-current-year transaction,
  term ordering / sequence uniqueness / within-year bounds (unit, no DB).
- `person-type.spec.ts` — `staffScope`/`applyStaffScope` + the directory guard.
- `features/academic.e2e-spec.ts` — CRUD, one-current rule, RBAC (employee 403),
  tenant isolation, term ordering + out-of-year rejection, and the personType
  directory/seat guard (jest-cucumber, isolated PG, dev-OTP).

## Migrations

- `1788030000000-MembershipPersonType` — adds `person_type` + its index.
- `1788031000000-Academic` — `academic_years` + `terms` with the invariant indexes.

Both are registered in `test/global-setup.ts` (entities + migrations arrays).
