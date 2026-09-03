---
module: lms
title: LMS — Courses, Classes/Sections & Enrolment
owner: education
status: live
phase: 1 (structure + enrolment)
addedAt: 2026-09-04
---

# LMS — Courses, Classes/Sections & Enrolment

**Phase 1** of the education vertical. Sits directly on the P0 academic calendar
(`academic_years` + `terms`) and the `personType`/`staffScope` guard. It adds the
academic **structure** (courses, taught class/sections) and the **enrolment** that
links **student** memberships to a class. No frontend, no bulk student import, no
public self-enrolment — students/guardians are introduced only inside tests.

Base path `POST/GET/PUT/DELETE /api/v1/lms`. Course/class/enrolment authoring is
**owner/admin only** (`LmsAccessGuard`), always scoped to the JWT's org — routes
never take an org id from the client, so org A can't touch org B's LMS data
(cross-org → 404). The **class roster** is the one non-admin surface (see below).

## ⚠️ The `personType` guard — this module is where it bites BOTH ways

The P0 guard keeps **students off staff surfaces**. LMS is the first module that
also relies on it the OTHER way:

- A class **teacher MUST be staff** — `assertTeacherIsStaff` looks the membership
  up with `staffScope({ id, organizationId })` (personType='staff'); a student id
  resolves to null → **400**. A student can never teach.
- An **enrolee MUST be a student** — `assertMembershipIsStudent` rejects any
  membership whose `personType != 'student'` (staff/guardian) with **400**.

Neither is expressible as a column constraint, so both live in `LmsService`. The
unit spec `lms.service.spec.ts` is a **build-failing guard**: remove either check
and it goes red. The e2e asserts both over HTTP.

## Entities

### Course (`courses`)
`{ organizationId, academicYearId?, code, name, description?, subject?, credits?, isActive }`
- `code` is UNIQUE per org **among active courses** — partial-unique
  `(organization_id, code) WHERE is_active = true`, plus a service pre-check.
  Archiving a course (`isActive=false`) **frees its code** for reuse.
- `academicYearId` optional (year-agnostic catalog entries allowed). A Course
  carries no students; its taught instances are class/sections.
- `DELETE` is refused while any class/section references the course (archive
  instead).

### ClassSection (`class_sections`)
`{ organizationId, courseId, termId, section, teacherMembershipId?, capacity?, isActive }`
- A taught instance of a course in a term. UNIQUE `(course_id, term_id, section)`
  — one section label per course/term.
- `teacherMembershipId` optional, **must be staff** (validated at assign time).
- `capacity` optional; caps ACTIVE (status='enrolled') students. Lowering
  capacity below the current active count is rejected.
- `DELETE` refused while any enrolment (any status) references the class
  (deactivate instead). `getClass`/`listClasses` return a live `enrolledCount`.

### Enrolment (`enrolments`)
`{ organizationId, classId, studentMembershipId, status, enrolledAt, withdrawnAt?, completedAt? }`
- `status ∈ { enrolled | withdrawn | completed }`.
- UNIQUE `(class_id, student_membership_id)` — **no double-enrolment**.
- **Withdraw is a soft transition** (`status='withdrawn'`, `withdrawnAt` stamped),
  never a delete — history/future grades survive.
- **Re-enrol** of a withdrawn student flips the SAME row back to `enrolled`
  (so the unique index is never violated). Re-enrolling an already-`enrolled` or
  `completed` student → 400.
- **Capacity** is enforced inside a transaction that takes a `pessimistic_write`
  lock on the class row first, so concurrent enrolments can't overfill a class.

## Routes

```
POST   /lms/courses                                   create course           (owner/admin)
GET    /lms/courses                                   list courses            (owner/admin)
GET    /lms/courses/:courseId                         one course              (owner/admin)
PUT    /lms/courses/:courseId                         update course           (owner/admin)
DELETE /lms/courses/:courseId                         delete (if no classes)  (owner/admin)

POST   /lms/classes                                   create class/section    (owner/admin)
GET    /lms/classes?courseId=&termId=                 list classes (filters)  (owner/admin)
GET    /lms/classes/:classId                          one class + count       (owner/admin)
PUT    /lms/classes/:classId                          update class            (owner/admin)
DELETE /lms/classes/:classId                          delete (if no enrols)   (owner/admin)
GET    /lms/classes/:classId/roster                   enrolled-student roster (owner/admin OR class teacher)

POST   /lms/classes/:classId/enrolments               enrol a student         (owner/admin)
GET    /lms/classes/:classId/enrolments               list enrolments (any)   (owner/admin)
PUT    /lms/classes/:classId/enrolments/:id/withdraw  soft withdraw           (owner/admin)
PUT    /lms/classes/:classId/enrolments/:id/complete  mark completed          (owner/admin)
```

### The roster is NOT the staff directory
`GET /lms/classes/:id/roster` is the legitimate student/teacher-facing read. It
uses `JwtAuthGuard` only (deliberately NOT `LmsAccessGuard`); `LmsService.roster`
authorizes it to **owner/admin OR the class's assigned teacher membership** and
returns **only actively-enrolled students** — never staff, never the org
directory, never withdrawn/completed rows. DPDP: it returns the minimum needed to
run a class (student membership id, user id, display name, email); it does not
expose broader minor data.

## Tests

- `lms.service.spec.ts` — 16 unit specs (no DB). Course-code uniqueness,
  teacher-must-be-staff, and the **build-failing enrolment guard**: student-only
  enrol (staff/guardian rejected), duplicate rejected, capacity enforced, soft
  withdraw, re-enrol-same-row, inactive-class rejected, roster student-only +
  teacher/admin access.
- `features/lms.feature` + `features/lms.e2e-spec.ts` — 9 Gherkin scenarios
  (jest-cucumber, `bootOrgTestApp`, dev-OTP `000000`): course/class CRUD, RBAC
  (employee 403), tenant isolation, teacher-must-be-staff (400), enrol-must-be-
  student (400), duplicate-enrolment (400), capacity (400 full), withdraw
  transition, and roster returns only enrolled students. Student memberships are
  inserted raw (personType='student') as the future vertical would.

## Migrations

- `1788032000000-Lms` — `courses`, `class_sections`, `enrolments` with the
  invariant indexes (partial-unique active course code; unique class section;
  unique enrolment per class/student).

Registered in `test/global-setup.ts` (entities + migrations arrays) and wired
into `app.module.ts` as `LmsModule`.

### Rollback

`npm run migration:revert` runs `Lms1788032000000.down`, dropping the three
tables and their indexes. No other table references them, so revert is clean.
The P0 `personType` column is a separate migration and is unaffected.

## Deferred (out of P1 scope)

- Bulk student import + guardian onboarding flows (guardian linkage is modelled
  via `personType='guardian'` but no LMS surface consumes it yet).
- Gradebook / attendance-per-class / timetable (the calendar + roster they hang
  off now exist).
- Public/self enrolment; capacity waitlists.

`createClass` validates BOTH that the course and the term exist within the
caller's org (`requireCourse` + `requireTerm`), so a class can never anchor to
another org's calendar. It does not yet assert the term falls under the course's
`academicYearId` — a cross-year class is currently allowed (revisit when a course
is required to pin a year).
