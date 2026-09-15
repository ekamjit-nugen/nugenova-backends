---
module: meetings
title: Meetings (Video)
owner: collaboration
status: live
phase: 1
migratedAt: 2026-09-10
source: nugenova-backend/src/modules/meetings
---

# Meetings (Video)

Members **schedule** or **start-now** video meetings, **invite** colleagues,
and **join** a Jitsi room. Our app owns scheduling, invites, access control and
lifecycle; the actual A/V room is a **Jitsi** room keyed by an unguessable,
org-scoped `roomName`. Net-new for Nexora (no monolith predecessor — the legacy
calling module was not carried over). Person = `User` + `OrgMembership`
(`userId` is the auth id); org admins/owners can manage any meeting.

Beyond the schedule → invite → join core, the following have landed on top:
**instant ("meet now")** meetings, **recurrence** (none/daily/weekly, standing
rooms), **add-people-mid-call** (group-ready), **start/cancel/end** lifecycle
with notifications, an **auto-end cron** for abandoned live rooms, and the
**frontend** meetings page + branded in-room UI + a **schedule composer** reused
by the Calendar's click-to-schedule. Recording, remote screen control, and a
self-hosted JWT Jitsi deployment remain optional/**deferred** (see **Deferred**).

## Access & isolation (the #1 rule)

Every read AND write is org-scoped **AND** access-checked:

- `requireMeeting` loads by `{ id, organizationId, isDeleted:false }` then calls
  `canAccess`. A cross-org id is a **404** (never confirm it exists elsewhere);
  a same-org non-participant is a **403**.
- `canAccess` = caller is an **org admin/owner** OR the **host** OR listed in
  `participants[]`. The list endpoint filters the same way, so members only ever
  see meetings they host or are invited to (admins see all).
- Host-only actions — **update, cancel, end, add-participants** — additionally
  require `isAdmin || hostId === caller`. Otherwise **403**.
- The Jitsi `roomName` is `nxr-<org6>-<slug>-<9 random bytes hex>` — long and
  org-scoped so it is effectively unguessable on a shared deployment.

Both guarantees are covered by e2e scenarios tagged `@security`
(`meetings.feature`) and by unit specs (`meetings.service.spec.ts`).

## Lifecycle & rules

- **Schedule** (`POST /meetings`) — creates a `scheduled` meeting with an
  optional start/end, invitees, lobby and recurrence. Fires `meeting_invited`
  to invitees (never the host).
- **Instant** (`POST /meetings/instant`) — creates a `live`, `isInstant`
  meeting and returns the join config immediately; notifies invitees to join now.
- **Join** (`POST /meetings/:id/join`) — access-checked. The **first** join of a
  `scheduled` meeting flips it **live** and fires `meeting_started` to everyone
  invited (this is the "your meeting has started" notification). Joining a
  `cancelled`/`ended` meeting → **400**.
- **Add participants** (`POST /meetings/:id/participants`) — host-only; dedupes
  against existing participants + host; notifies only the newly added.
- **Update** (`PATCH /meetings/:id`) — host-only; blocked once `ended`/
  `cancelled`; notifies invitees `meeting_updated`.
- **Cancel** / **End** — host-only; set status `cancelled`/`ended`. Cancel
  notifies invitees `meeting_cancelled`.
- **Auto-end** (`endStale`, hourly cron) — ends abandoned `live` meetings so they
  don't linger in "Live now": a **recurring** meeting's room is **never**
  auto-ended (standing room); a meeting with a `scheduledEnd` ends 30 min past
  it; otherwise it ends after a 12 h max-live window.

## Jitsi config (env-driven)

`buildJoin` returns the room config the client embeds. `JITSI_DOMAIN` defaults
to `meet.jit.si` (anonymous). When `JITSI_APP_ID` + `JITSI_APP_SECRET` are set
(self-hosted / JaaS), `mintJwt` signs an HS256 prosody JWT (4 h TTL) granting the
host **moderator** rights; absent those, `jwt` is `null` (anonymous room). The
host / admins are always `moderator: true`.

## Endpoints (`/api/v1/meetings`, JWT + ModuleEnabledGuard `@RequireModule('meetings')`)

| Method | Path | Access | What |
|---|---|---|---|
| POST | `/meetings` | any member | Schedule a meeting (+ invites). |
| POST | `/meetings/instant` | any member | Start now; returns join config. |
| GET | `/meetings/incoming` | any member | Meetings the caller is **invited to** (not hosting) that are joinable now: live, scheduled from 5 min before start until end (60 min default length), or undated and created in the last hour. Feeds the join popup. |
| GET | `/meetings` | any member | The caller's accessible meetings (admins: all). |
| GET | `/meetings/:id` | host / invitee / admin | One meeting. |
| PATCH | `/meetings/:id` | host / admin | Edit (title/desc/time/lobby/invitees). |
| POST | `/meetings/:id/join` | host / invitee / admin | Join (flips scheduled→live). |
| POST | `/meetings/:id/participants` | host / admin | Add people (+ notify). |
| POST | `/meetings/:id/cancel` | host / admin | Cancel (+ notify). |
| POST | `/meetings/:id/end` | host / admin | End. |

The whole controller is gated on the org having the **`meetings`** module
enabled (`ModuleEnabledGuard`); a disabled org gets the module-gate rejection.

## Data model

- **`meetings`** (`MeetingEntity`) — org + `title`/`description`, `hostId`/
  `hostName`, **`roomName`** (unique, unguessable), `scheduledStart`/
  `scheduledEnd` (timestamptz), `status` (scheduled|live|ended|cancelled),
  `isInstant`, **`recurrence`** (none|daily|weekly), `participants` (jsonb
  `{userId,name}[]`), `lobbyEnabled`, `passcode`, `startedAt`/`endedAt`,
  `isDeleted`. Indexes on (org), (host), (scheduledStart).

Migrations `Meetings1788200000000` + `MeetingRecurrence1788210000000`
(registered in `test/global-setup.ts`).

## Frontend

- `app/meetings/page.tsx` — hero with **Start instant meeting** + **Schedule**,
  KPIs (live/upcoming/past), and live/upcoming/past sections with join, cancel,
  and `.ics` download.
- `app/meetings/[id]/page.tsx` — branded room (Nugenova logo), host **Add
  people** + **Copy link**, Leave.
- `components/meetings/jitsi-room.tsx` — de-branded Jitsi embed, env logo.
- `components/meetings/schedule-meeting-modal.tsx` — the shared schedule composer
  (title/time/**active-members-only** invitees/recurrence/lobby), reused by the
  Meetings page and the **Calendar** click-to-schedule.
- Chat: a **Meet** action in direct + group chat starts an instant meeting and
  posts the join link.

## Rollback

Remove `MeetingsModule` from `app.module`; the `meetings` table is additive.
`migration:revert` drops it. No other module hard-depends on it (Calendar reads
the same table but tolerates its absence of rows).

## Deferred

- **Recording** to storage (Jitsi local recording only, no server capture).
- **Remote screen control** (explicitly dropped for this phase).
- **Self-hosted JWT Jitsi / JaaS** rollout + lobby knock UI (env-ready, not
  provisioned).
- **RSVP / accept-decline**, per-occurrence edits/exceptions for recurring
  series (recurrence is a simple daily/weekly expansion today).
- **Waiting-room admit controls** surfaced in our UI (handled inside Jitsi).

## Scenarios & tests

`features/meetings.feature` + `meetings.e2e-spec.ts` (6 e2e, jest-cucumber):
schedule + notify-invitees, list is access-filtered, invitee opens it / same-org
stranger 403 (`@security`), first-join flips scheduled→live + returns a room,
host-only cancel (member 403 `@security`), instant + add-participants dedupe.
Unit
`meetings.service.spec.ts` (5): create+notify (not host), join→live meet.jit.si
config (no jwt), participant-can/stranger-cannot access, addParticipants
host-only + dedupe + notify, `endStale` ends abandoned but keeps a recurring
room.

## Join popup (frontend)

`components/meetings/incoming-meeting-popup.tsx`, mounted in the app shell when the
`meetings` module is allowed (not for super admins). Polls `GET /meetings/incoming`
every 15 s (and when the tab becomes visible; paused while hidden) and shows a
top-centre card per meeting — "Live now" / "Starts in N min", title, host — with
**Join** (→ `/meetings/:id`) and **Dismiss**. Joined/dismissed meetings are remembered
per browser for 24 h; no card inside the meeting you're already in; polling stops on
401/403/404 (module disabled).

