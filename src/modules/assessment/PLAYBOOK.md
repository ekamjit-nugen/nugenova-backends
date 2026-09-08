---
module: assessment
title: Assessment — Gradebook, Marks & Student Reports
owner: education
status: live
phase: 2 (gradebook)
addedAt: 2026-09-08
---

# Assessment — Gradebook, Marks & Student Reports

**Phase 2** of the education vertical. Sits directly on the P1 lms roster
(`class_sections` + `enrolments`) and, through the class, on the P0 academic
calendar (`terms`) and the `personType`/`staffScope` guard. It adds the
**gradebook**: assessments (graded items on a class/section) and the per-student
**marks**, plus two rolled-up reads — the class gradebook matrix and a single
student's report. No frontend, no bulk import, no student/guardian-facing surface
— students are introduced only inside tests (as the future vertical would).

Base path `POST/GET/PUT/DELETE /api/v1/assessment`. Assessment/mark **authoring is
owner/admin only** (`AssessmentAccessGuard`), always scoped to the JWT's org —
routes never take an org id from the client, so org A can't touch org B's
gradebook (cross-org → 404). The **gradebook** and **student report** are the
non-admin reads (see below).

## ⚠️ The `personType` guard — the gradebook grades STUDENTS only

The P0 guard keeps students off staff surfaces; here it bites the OTHER way, like
lms enrolment:

- A graded subject **MUST be a student** — `assertMembershipIsStudent` rejects any
  membership whose `personType != 'student'` (staff/guardian) with **400**. Staff
  never enter the gradebook. This is defence-in-depth on top of the fact that only
  students can be enrolled in the first place (lms enforces that at enrol time).

The unit spec `assessment.service.spec.ts` is a **build-failing guard**: remove the
student check (or the range/enrolled checks, or the weighted-total math) and it
goes red. The e2e asserts the invariants over HTTP.

## Entities

### Assessment (`assessments`)
`{ organizationId, classSectionId, termId, title, type, maxMarks, weight, dueDate?, published }`
- A gradebook **column**: a graded item on a `class_sections` row.
- `type ∈ { quiz | assignment | exam | project }`.
- `termId` is **DERIVED from the class** at creation (a class is already anchored
  to exactly one term), so an assessment can never disagree with its class's
  calendar. It is never taken from the client.
- `maxMarks` (numeric) is the denominator every cell is scored out of; `weight`
  (numeric, default 1) is its contribution to the weighted total.
- `published` (default false) is an author-facing visibility flag **reserved for a
  future student/guardian-facing surface** — the admin/teacher gradebook shows all
  assessments regardless of it today.
- Indexed by `(organizationId, classSectionId)` — the primary read path.
- `DELETE` cascades to the assessment's marks (a cell is meaningless without its
  column).

### Mark (`assessment_marks`)
`{ organizationId, assessmentId, enrolmentId, studentMembershipId, marksObtained?, gradedBy?, gradedAt?, remark? }`
- A gradebook **cell**: one student's score on one assessment, linked to the
  student's `enrolments` row.
- `studentMembershipId` is **denormalized** from the enrolment — pins the student
  identity at grade time and lets the row be scoped/rendered without a join.
- UNIQUE `(assessment_id, enrolment_id)` — **no duplicate cell**. A **re-grade
  flips the SAME row** (mirrors the lms "re-enrol on the same row" pattern), never
  an insert, so the unique index is never violated.
- `marksObtained` is **nullable**: `null` = "not yet graded" (distinct from a
  genuine zero). When not null it must be within `[0, maxMarks]`. Only graded cells
  count toward a student's weighted total.

## Routes

```
POST   /assessment/classes/:classId/assessments      create assessment        (owner/admin)
GET    /assessment/classes/:classId/assessments      list class assessments   (owner/admin)
GET    /assessment/assessments/:assessmentId         one assessment           (owner/admin)
PUT    /assessment/assessments/:assessmentId         update assessment        (owner/admin)
DELETE /assessment/assessments/:assessmentId         delete (+ its marks)     (owner/admin)

POST   /assessment/assessments/:assessmentId/marks   record/re-grade a mark   (owner/admin)

GET    /assessment/classes/:classId/gradebook        roster × assessment matrix + weighted totals  (owner/admin OR class teacher)
GET    /assessment/enrolments/:enrolmentId/report    one student's marks + overall                  (owner/admin OR class teacher)
```

### The reads are teacher-facing (NOT the staff directory)
`GET .../gradebook` and `.../report` use `JwtAuthGuard` only (deliberately NOT
`AssessmentAccessGuard`); `AssessmentService` authorizes them to **owner/admin OR
the class's assigned teacher membership**, exactly like the lms roster. They return
only **actively-enrolled students** (from the lms roster) — never staff, never the
org directory, never withdrawn/completed enrolments. Display data is the minimum
needed to run a class (student membership id, user id, name, email).

### Weighted total
For each **graded** assessment a student contributes `weight × (obtained /
maxMarks)`; the **weighted percentage** normalises by the summed weight of the
graded assessments, so an ungraded item neither helps nor hurts:

```
weightedPercentage = Σ(weightᵢ · obtainedᵢ/maxᵢ) / Σ(weightᵢ) · 100   (graded only)
```

It is `0` when nothing is graded. Each row/report also carries the raw
`totalObtained` / `totalMax` (over graded items) and `gradedCount`. Marks and
percentages are rounded to 2 decimals (display values, not money). numeric columns
read back as strings from Postgres, so every view maps them through `Number()`.

## Tests

- `assessment.service.spec.ts` — 13 unit specs (no DB). Term-derived-from-class,
  and the **build-failing guards**: mark-out-of-range (and negative) rejected,
  only-enrolled graded, student-only graded, fresh-mark denormalizes the student,
  **re-grade updates the same row**, clear-to-null, **weighted-total math**
  (weights + ungraded-excluded + zero-when-none), read auth (teacher/admin),
  student report.
- `features/assessment.feature` + `features/assessment.e2e-spec.ts` — 8 Gherkin
  scenarios (jest-cucumber, `bootOrgTestApp`): assessment create (term inherited),
  RBAC (employee 403), tenant isolation (cross-org gradebook 404), only-enrolled
  graded (400), mark range (400), re-grade-same-row, gradebook weighted total, and
  student report. Student memberships are inserted raw (personType='student').

## Migrations

- `1788100000000-Assessment` — `assessments` and `assessment_marks` with the
  invariant index (unique mark per assessment/enrolment) and the read-path indexes.

Registered in `test/global-setup.ts` (entities + migrations arrays) and wired into
`app.module.ts` as `AssessmentModule`.

### Rollback

`npm run migration:revert` runs `Assessment1788100000000.down`, dropping both
tables and their indexes. No other table references them, so revert is clean.

## Deferred (out of P2 scope)

- **Student/guardian-facing views** — the `published` flag exists to gate them but
  no surface consumes it yet; the gradebook shows all assessments to staff today.
- **Letter grades / grade scales / GPA** — only raw marks and a weighted % are
  computed; a configurable grade-band mapping is a future seam.
- **Term/course rollups** — the report is per class (one enrolment). Cross-class or
  whole-term transcripts are not modelled yet.
- **Attendance-weighted or dropped-lowest policies**, resubmissions/attempts, and
  late-penalty rules — a single mark per (assessment, student) only.
- **Teacher self-grading vs. admin** distinctions beyond the roster-style read
  auth; mark authoring is still owner/admin only (the class teacher can read the
  gradebook but not yet record marks — revisit when teacher accounts land).
- The assessment does not assert its `dueDate` falls within the term's date range
  (mirrors lms not asserting the term falls under the course's year).
