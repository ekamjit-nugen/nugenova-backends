---
module: attendance
title: Attendance & Time Tracking
owner: people
status: live
phase: 3
migratedAt: 2026-08-25
source: nugenova-monolith/src/modules/attendance
---

# Attendance & Time Tracking

The interactive time-tracking surface, ported from the Nugenova monolith to
Postgres/TypeORM. An employee **clocks in and out** through the day (each
in/out pair is a *session segment* on one record per day); managers, HR and
owners see the **org roster**, an **activity feed**, and the **approval queues**;
everyone can read the **holiday calendar**.

This is Phase 1 of the module — the interactive surface, org-scoped and
permission-gated. The policy/shift engine, geo-fence, work-from-home caps, the
absence/nudge/digest/missed-checkout crons, alerts and the payroll day-summary
public-api are **Phase 2**, landing with their dependency modules (Policy, HR,
Leave, Notification, Payroll). See **Deferred** below.

## What the module guarantees

- **One record per (org, employee, org-tz calendar day).** Re-clocking in the
  same day appends a session segment rather than creating a second row; worked
  hours sum the closed segments and the top-level in/out mirror the first-in /
  last-out. A partial-unique index enforces one live *system* record per day.
- **Timezone-anchored days (G-X3).** Every record's `date` is a UTC-midnight
  anchor whose Y/M/D equal the **org-local** calendar day, so a 02:00-local
  clock-in buckets to the correct day and the unique index holds. Ported
  verbatim as the `tz-day.util` pure module.
- **Policy-driven status (G-C4).** present / late / half_day derived from a
  work-timing (grace, late-to-half-day, min-hours). Until the Policy module
  migrates, the monolith's default work-timing (09:00–18:00 IST, 15-min grace,
  8h min) is used — exactly the monolith's own fallback.
- **Admins don't clock their own time.** An owner/admin (or a platform-admin
  role) is blocked from clock-in — they *manage* attendance rather than track
  it. HR and managers are ICs and still clock in (monolith parity).

## Tenant isolation & authorization

Attendance is a **strictly org-scoped** surface. `AttendanceAccessGuard`
(after `JwtAuthGuard`):

1. **Fail-closed on missing org.** Access is by ORG MEMBERSHIP only. A JWT with
   no `organizationId` (a platform super-admin) is **rejected** — super admins
   manage tenants via `/admin/*` and must never read an org's attendance. This
   closes the monolith's null-org leak by construction: the monolith scoped with
   `if (orgId) filter.organizationId = orgId`, so a null-org token dropped the
   filter and read **every** org's rows. In this port `orgId` is guaranteed and
   ALWAYS applied.
2. **Lifecycle gate.** A suspended or consent-pending org is blocked.
3. **Permission gate.** A route tagged `@RequirePermission('attendance', …)` is
   reachable by owner/admin OR a permScoped custom role whose matrix grants it
   (the org-wide surfaces). A route WITHOUT it is **self-service** — any active
   member (clock-in/out, my, today, stats, manual-entry, request-edit).

Stats self-scope automatically: a plain employee sees only their own numbers; a
privileged caller (owner/admin or an `attendance:view` role) sees org-wide — the
employee is never *blocked*, just scoped.

**Permission semantics — `attendance:view` means the ORG-WIDE surface, not "my
attendance".** Clock-in/out, `today`, `my` and `stats` are self-service and need
NO permission, so the only thing `attendance:view` unlocks is the team roster /
activity / approvals. Consequently an IC default role (developer, designer) must
NOT carry `attendance:view` — doing so would expose the whole org's attendance to
every IC (a bug that was caught and fixed: the default roles were stripped of
`attendance`). Team access is owner/admin or a role explicitly granted
`attendance:view`/`edit` (e.g. HR). NB: the same rule will apply to `leaves` when
that module migrates.

**Department scoping — "a manager leads their own team."** A custom role can be
**bound to a department** (`Role.departmentId`); a member holding it carries a
`departmentScopeId` in their JWT. When present, every org-wide attendance **read**
(`/attendance`, `/attendance/activity`, `/attendance/pending-approvals`, and the
org branch of `/attendance/stats`) is **narrowed at the query level** to that
department's active members (the lead always included), and every cross-department
**write** (approve, review-edit, manual-entry-on-behalf) is **refused 403**.
Owner/admin are never permScoped, so they are **never narrowed** — they see the
whole org. So one department can hold a *manager* role (attendance:view+edit,
scoped to the dept → leads exactly that team) alongside *developer* roles (no
attendance permission → self-service clock-in only), and the manager sees/approves
only their own people. Assigning a department-scoped role also places the member
in that department, keeping their membership in step with the scope their token
carries.

## Overview & endpoints

All routes are under the global `/api/v1` prefix.

### Self-service (any active member)

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/attendance/check-in` | Clock in (opens a session segment). `{location?, workMode?}`. Blocked for admins/owners. |
| POST | `/attendance/check-out` | Clock out (closes the open segment, recomputes hours + status). |
| GET | `/attendance/today` | Today's status: checkedIn / open session / total hours / sessions. |
| GET | `/attendance/my` | The caller's own records (`startDate`/`endDate`). |
| GET | `/attendance/stats` | Counts by status + pending approvals; **self- or org-scoped** by role. |
| POST | `/attendance/manual-entry` | Submit a manual time entry for approval. |
| PUT | `/attendance/:id/request-edit` | Propose a correction to one's own record. |
| GET | `/holidays` | The org holiday calendar (`year?`). |

### Org-wide (`@RequirePermission('attendance', …)` — owner/admin or a matrix role)

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| GET | `/attendance` | attendance:view | Org roster of records (`status`, date range, `search`, `departmentId`). |
| GET | `/attendance/activity` | attendance:view | Activity feed (`view=timeline\|grouped`). |
| GET | `/attendance/pending-approvals` | attendance:view | Manual + edit-request approval queues. |
| PUT | `/attendance/:id/approve` | attendance:edit | Approve/reject a manual entry (self-approval blocked). |
| PUT | `/attendance/:id/review-edit` | attendance:edit | Approve/reject an edit request. |
| POST | `/holidays` | attendance:edit | Add a holiday. |
| DELETE | `/holidays/:id` | attendance:edit | Remove a holiday. |

### Data model (entities → tables)

- **`attendance`** — one record per (org, employee, day). `employee_id` is the
  auth **userId** (not the HR employee id). Session segments, geo breadcrumb,
  status/late/early fields, entry type (`system|manual|regularization|force`),
  manual-entry approval + `pending_edit` (jsonb), missed-checkout flags. Partial
  UNIQUE `(org, employee, date)` where `entry_type='system' AND NOT is_deleted`.
- **`holidays`** — org-wide non-working days. Partial UNIQUE `(org, date)` where
  `NOT is_deleted`; `year` denormalised for the calendar filter.

## Migration status & steps

- **Status:** ✅ live on Postgres (Phase 1 — interactive surface). Verified end
  to end: clock in → clock out, re-clock conflict, admin clock-in block, self
  vs org stats, cross-org isolation, super-admin isolation, permScoped
  `attendance:view` access, plain-employee denial, holiday read/write gating.
- **Entities:** `AttendanceEntity`, `HolidayEntity`; reuses `User`,
  `OrgMembership`, `Organization` from auth/organization.
- **Migration:** `AttendanceHolidays1787800000000` — creates `attendance` +
  `holidays` with their partial-unique indexes.
- **Run migrations:** `npm run migration:run`

## Rollback

Additive and reversible — the Mongo monolith is untouched.

1. `npm run migration:revert` drops `holidays` and `attendance`.
2. Remove `AttendanceModule` from `app.module.ts` to unmount the routes, and the
   Time & Attendance section from the frontend sidebar.

## Governed by Policy (done — see the `policy` playbook)

Attendance now resolves each employee's governing **work-timing policy** on every
clock-in (specific ▸ department ▸ all) and derives status from IT, not a hardcoded
default. **WFH** (allowed-days + monthly cap) and the **office geo-fence** are
enforced from the resolved policy. A default work-timing policy is seeded for
every org, so a policy always applies. (`AttendanceService.resolveContext` →
`PolicyService.resolveForEmployee`.)

**Location at clock-in (office geo-fence).** When an office policy governs the
employee, `POST /attendance/check-in` **requires** a `{location:{latitude,
longitude}}` and rejects a clock-in with no location or one outside the fence
(`enforceWorkLocation`, haversine vs. each office's `radiusKm` / the policy's
`geoFenceRadiusKm`, default 2 km). The web client captures it via
`navigator.geolocation` and sends it on clock-in; home/hybrid policies never block.
When the browser/OS **blocks** location and the policy requires it, the client
shows a **"Turn on location to clock in"** help modal with steps tailored to the
detected browser (Chrome/Edge/Firefox/Safari) AND operating system
(macOS/Windows/iOS/Android/Linux) — `detectEnableSteps()` — plus a "Try again".
An outside-the-fence rejection (location WAS read) shows the plain error instead.
Because an office policy tracks the person, it is **consent-gated** — see the
policy playbook's "Location tracking → consent required": the geo-fence template is
`acknowledgementRequired`, so an attached employee must accept (login gate) before
it applies.

Each record persists the `checkInLocation` (lat/long/accuracy) + a `geoCheck`
breadcrumb (`mode`, `verified`, `distanceKm`, `officeName`), both already returned
by the list endpoints. The web attendance table surfaces them in a **Location**
column (`geoSummary`): "At <office> · N km" (verified inside), "Outside fence · N
km", "Work from home", or "No location". Clicking a located record's badge
**expands the row inline (collapsible, animated)** to reveal the full breadcrumb
(coordinates, accuracy, distance, office, geo-fence result) and a **View on map**
link (`google.com/maps?q=lat,long`) — no modal.

**Self vs. management view.** A member without `attendance:view` (owner/admin/HR or
a matrix role) sees **only their own** records — the org-wide `/attendance` fetch
and the Activity feed are gated off, and the web self-view offers date-range
filters (today / this week / this month / last month / all / custom, default
today) over their own history.

**Work-from-home is a request → approval flow (no self-declare).** WFH is never
self-declared at clock-in. An employee **requests** a date range
(`POST /attendance/wfh-requests`, `GET .../mine`, `POST .../:id/cancel`); an
owner/HR **reviews** it (`GET .../pending`, `PUT .../:id/review` — `attendance:view`
/`:edit`). At clock-in `isWfh` is decided by `WfhRequestService.hasApprovedForDay`
(an approved request covering today in the org tz) — an approved day records the
record as `wfh` and **skips the office geo-fence**; every other clock-in is
geo-fenced normally. Entity `wfh_requests` (migration `WfhRequests1787850000000`).
The web clock button reads "Clock In (WFH)" on an approved day; the "Work from
Home" tab holds the request modal, the member's own requests, and (for managers)
the pending-approvals queue.

## Deferred (Phase 2 — dependency-gated)

- **Shift CRUD** — the resolver already honours `shift`-category timing policies;
  a dedicated shift-management surface lands later.
- **Crons** — absence marking, missed-clock-in nudge, daily exception digest,
  and missed-checkout reconciliation need **HR** (`listActiveEmployees`),
  **Leave** (approved-leave exclusion) and **Notification**.
- **Alerts & escalation** — late/early/overtime/geo-unverified alerts and
  manager escalation need Notification.
- **Payroll public-api** — `getDaysSummary` / `getWorkingDaysInMonth/Range`
  land when **Payroll** migrates (consumer).
- **Approved-leave clock-in guard (G-C1)** and **vendor clock-in gating** —
  land with Leave and the vendor/HR surfaces.

### Known Phase-1 limitations (not regressions — bounded/documented)

- **Activity "By person" shows only people with a record** — the legacy
  `not_clocked_in` roster diff (active roster minus today's records) needs the HR
  roster; deferred with the HR module. The grouped view therefore under-reports
  absentees until then.
- **Attendance-page KPI cards are all-time cumulative** (no date window), faithful
  to the monolith. The dashboard "Who's In Today" strip makes a separate
  today-scoped call. A windowed KPI selector can come later.
- **Org-wide reads are capped, not paginated** — `getAllAttendance` /
  `getActivityFeed` bound results to 2000 rows and clamp the activity window to 92
  days (the monolith paginated). Full `page`/`limit` pagination is a Phase-2 item.
- **Segment writes are last-write-wins** — concurrent re-clock-in/clock-out on one
  existing day row have no optimistic lock (the unique index only guards new-row
  creation). Matches the monolith; needs one user firing concurrent requests.

## Scenarios & tests

Gherkin scenarios live in `src/modules/attendance/features/*.feature`, bound to
a supertest integration spec (`attendance.e2e-spec.ts`, jest-cucumber) that
covers the clock loop, stats scope, and — the tiers the monolith never tested —
cross-tenant isolation, super-admin isolation, and the permission matrix. Pure
units cover the tz-day anchoring, the status vocabulary/payroll buckets, and the
status-derivation thresholds. The frontend has vitest component tests
(role-based rendering) and a Playwright visibility scenario. Live pass/fail +
coverage from the latest CI run are merged into this playbook by the
`admin-playbooks` API.
