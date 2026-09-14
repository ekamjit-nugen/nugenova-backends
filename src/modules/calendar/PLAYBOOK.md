---
module: calendar
title: Calendar
owner: people
status: live
phase: 1
migratedAt: 2026-09-10
source: nugenova-backend/src/modules/calendar
---

# Calendar

One **read-only** org-scoped feed that aggregates, for a date window,
**holidays**, who is on **leave** (with **WFH** split out), the caller's
**meetings** (recurrence-expanded), and team **birthdays**. Net-new for Nexora.
Person = `User` + `OrgMembership`. There is no calendar table — the feed is
computed on the fly from the source modules, so it is always consistent with
them and needs no migration.

## The feed

`GET /api/v1/calendar?from=&to=` → `CalendarEvent[]`. Each event:
`{ id, type, title, start, end, allDay, meta }`. `start`/`end` are `YYYY-MM-DD`
for all-day events and full ISO datetimes for meetings. Window defaults to the
**current month** when `from`/`to` are omitted. Event types:

- **`holiday`** — org holidays in range (`HolidayEntity`, not deleted).
- **`leave`** — **approved** leave overlapping the window; title is the real
  person's name (resolved from `users`, not the denormalised `employeeName`) +
  the leave-type label + `(half day)`.
- **`wfh`** — approved leave whose `leaveType === 'wfh'`, split into its **own**
  event type (and its own frontend filter) so "working from home" reads
  differently from being away.
- **`meeting`** — the caller's **accessible** meetings, **recurrence-expanded**
  into per-occurrence events within the window; carries `meta.meetingId` so the
  UI can deep-link.
- **`birthday`** — from `users.dateOfBirth`, projected onto each year in range.

## Access & scoping

- Org-scoped: holidays, leave, birthdays are all filtered to the caller's org
  (active memberships → `users`).
- **Meetings are access-filtered** the same way the Meetings module does it: a
  meeting is included only if the caller is an **admin/owner**, the **host**, or
  a **participant**. A member never sees meetings they aren't part of.
- `cancelled` meetings are excluded; only meetings with a `scheduledStart` are
  placed on the calendar.

## Recurrence expansion

`expandOccurrences(base, recurrence, from, to)` fast-forwards to the first
occurrence at/after `from` then steps by day/week up to `to` (capped at 400
occurrences). Duration is preserved from `scheduledEnd − scheduledStart`
(default 1 h). `none` yields the single occurrence only when it falls in range.

## Endpoint (`/api/v1/calendar`, JWT + ModuleEnabledGuard `@RequireModule('calendar')`)

| Method | Path | Access | What |
|---|---|---|---|
| GET | `/calendar?from&to` | any member | Aggregated feed for the window. |

Gated on the org having the **`calendar`** module enabled; a disabled org gets
the module-gate rejection.

## Data model

No own tables. Reads from `HolidayEntity`, `LeaveRequestEntity`,
`MeetingEntity`, `OrgMembershipEntity`, `UserEntity`. Purely additive — nothing
to migrate or roll back beyond removing the module.

## Frontend

`app/calendar/page.tsx`:

- **Month** grid (unchanged) + **Week** and **Day** time-grid views
  (Google-Calendar style): hour gutter, 30-minute gridlines, all-day band,
  timed meetings positioned by start/end with overlap lanes.
- Type **filters** (holiday / on-leave / WFH / meetings / birthdays), a live
  current-time line, and **default weekly** view.
- **Click a slot** (or **New meeting**) opens the shared `ScheduleMeetingModal`
  prefilled to that day+time; a **crosshair hover** highlights the target row +
  column before clicking. Week columns are fixed-width with **horizontal scroll**
  (sticky header row + sticky time gutter).

## Notifications

The calendar itself is read-only. The **meeting-started** notification to
invitees is fired by the **Meetings** module on first join (`meeting_started`);
the calendar simply surfaces the schedule. See the Meetings playbook.

## Rollback

Remove `CalendarModule` from `app.module`. Nothing depends on it and it owns no
tables.

## Deferred

- **iCal/ICS subscription feed** + external calendar (Google/Outlook) sync.
- **Writing** from the calendar beyond scheduling meetings (e.g. request leave /
  add a holiday inline).
- **Per-department / per-team** calendar scoping and shared team calendars.
- **Timezone-aware** all-day boundaries (dates are computed in the server/UTC
  frame today; the UI renders in the viewer's locale).

## Scenarios & tests

`features/calendar.feature` + `calendar.e2e-spec.ts` (6 e2e, jest-cucumber):
holidays in range, approved leave shows the real person's name, WFH is its own
`wfh` type, the caller's meeting appears / a same-org stranger's meeting is
filtered out (`@security`), a weekly meeting is recurrence-expanded to several
occurrences, a birthday projected from the date of birth. Unit
`calendar.service.spec.ts` (5): WFH split + leave-name resolution, meeting access
filter (member vs admin), weekly recurrence-expansion count, birthday
projection, holidays as all-day events.
