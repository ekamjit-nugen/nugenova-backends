---
module: activity
title: Activity & Audit
owner: platform
status: live
phase: 1
migratedAt: 2026-09-11
source: nugenova-backend/src/modules/activity
---

# Activity & Audit

One curated, org-scoped feed of what members do — login-adjacent actions, leave,
meetings, attendance, files, and AI usage — plus a 15-day retention job that
archives old logs to the org owner and purges them. Net-new for Nexora. There
was no prior activity/audit table (`AuditService` only logged to the app
logger); this is the durable store that seam always implied.

## What it captures (curated domain events)

`ActivityService.record()` is the single write choke point — **best-effort and
never throws** (activity logging must not break a real request). Wired at:

| Action | Category | Where |
|---|---|---|
| `meeting.created` / `meeting.started` / `meeting.joined` / `meeting.cancelled` | meetings | MeetingsService |
| `leave.applied` / `leave.approved` | leave | LeaveService |
| `attendance.clock_in` / `attendance.clock_out` | attendance | AttendanceService |
| `file.uploaded` | files | DriveService (non-system uploads) |
| `ai.used` | ai | AiUsageService (on every successful AI call) |

Adding a new event is a one-line `activity.record({...})` call — the service is
exported and injected `@Optional()` so unit specs are unaffected. (Auth login
capture going forward is a planned add — it needs a `forwardRef` into the auth
core and was deferred to avoid destabilising auth.)

**Historical backfill:** `src/bootstrap/database/etl/nugen-activity-migrate.ts`
loads the legacy Mongo `auditlogs` (real-member actors only; service/system
actors skipped) into `activity_events` — sign-ins, boards, attendance, leave,
HR, payroll, chat, notifications, etc. — and also surfaces each `ai_usage_events`
row as an `ai.used` feed entry. Idempotent (preserves the source `_id` as the
row id, `ON CONFLICT` upsert), org rewritten legacy → target. Run with
`SRC_MONGODB_URI` set (`ACTIVITY_DRY_RUN=1` to preview).

## AI usage

The lightweight `ai.used` row makes AI visible in the unified feed. The detailed
**metrics** (tokens, cost, model, prompt/output) live in `ai_usage_events` /
`ai_usage_counters` (the AI module) and are read via `/ai/usage*`. Historical
AI usage is backfilled from the legacy Mongo by
`src/bootstrap/database/etl/nugen-ai-usage-migrate.ts` (idempotent, dry-run
supported; run with `SRC_MONGODB_URI` set). **AI-usage metrics are never purged
by retention** — only the `ai.used` activity rows age out.

## Visibility

- `GET /activity` — admins/owners see the whole org; **members are force-scoped
  to their own** activity regardless of the requested `scope`/`actorId`.
- `GET /activity/me` — the caller's own activity.
- Filters: `category`, `actorId` (admins only), `from`/`to`, `page`/`limit`
  (≤100). Org-scoped and gated `@RequireModule('activity')`.

## Retention (the 15-day archive + purge)

`ActivityRetentionService`, driven by a daily cron (`ActivityCronService`,
03:20), per active org, on a **15-day cadence**:

1. **Claim** the org via a conditional UPDATE on `activity_retention_runs`
   (`locked_at` + `last_run_at`) — this is both the cadence gate and the
   single-run lock across instances (the codebase had no other distributed
   lock).
2. Gather `activity_events` older than 15 days, build a **zip** (CSV + JSON +
   README) with `jszip`.
3. **Email the zip to the org owner** (`organizations.ownerId` → user, falling
   back to the `owner` membership) as an attachment.
4. **Delete** exactly the archived ids — ONLY after the email is accepted.
   If no backup can be delivered (no owner email / send failed), nothing is
   deleted and the lock is released to retry next cycle (**backup-before-delete
   guarantee**).

Owners/admins can trigger it on demand: `POST /activity/retention/run` (skips
the 15-day wait, same lock + backup-before-delete rules).

Mail attachments: `MailSendOptions.attachments` was added and is forwarded by
the SMTP + ZeptoMail transports (the `outbox` dev driver persists the record and
counts as delivered).

## Endpoints (`/api/v1/activity`, JWT + ModuleEnabledGuard `@RequireModule('activity')`)

| Method | Path | Access | What |
|---|---|---|---|
| GET | `/activity` | any member (admins: all; members: own) | Activity feed. |
| GET | `/activity/me` | any member | The caller's own activity. |
| POST | `/activity/retention/run` | owner/admin | Archive+purge this org now. |

## Data model

- **`activity_events`** — org, `actorId`/`actorName`, `action`, `category`,
  `targetType`/`targetId`, `summary`, `metadata` (jsonb), `ip`, `createdAt`.
  Indexes on (org, createdAt), (org, actor, createdAt), (org, category,
  createdAt). This is the "logs" that age out at 15 days.
- **`activity_retention_runs`** — one row per org: `lastRunAt`, `lockedAt`,
  `lastArchivedCount` (cadence + lock).

Migration `Activity1788220000000` (registered in `test/global-setup.ts`).

## Frontend

`app/activity/page.tsx` — the activity feed with category filters and (for
admins) an org/mine toggle, plus tabs for **Attendance** (reuses
`/attendance/activity`) and **AI usage** (reuses `/ai/usage*`). Sidebar entry
gated on the `activity` module key.

## Rollback

Remove `ActivityModule` from `app.module`; drop the `record()` calls (they are
`@Optional`/best-effort, so removing the module leaves callers working). Tables
are additive; `migration:revert` drops them.

## Deferred

- **Auth login/logout** + settings-change capture (login needs a forwardRef into
  auth).
- **Raw per-request audit** stream (this is a curated feed by design).
- **Cloud-drive archive** of the retention zip (email-only today) and file
  download capture.

## Scenarios & tests

`features/activity.feature` + `activity.e2e-spec.ts` (3 e2e, jest-cucumber): an
action is captured in the feed, members see only their own activity (`@security`),
retention archives old logs to the owner (outbox) and purges them. Unit
`activity.service.spec.ts` (6: record persists + resolves name + never throws +
skips empties; list scoping member-vs-admin + page clamp) and
`activity-retention.service.spec.ts` (6: zip built + owner emailed + exact rows
deleted; no-claim; empty; backup-before-delete when no owner email; runAll).
