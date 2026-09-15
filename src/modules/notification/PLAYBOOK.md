---
module: notification
title: Notifications
owner: platform
status: live
phase: 4
migratedAt: 2026-08-27
source: nugenova-monolith/src/modules/notification
---

# Notifications

The per-recipient in-app notification system, ported from the Nugenova monolith
to Postgres/TypeORM. Every meaningful event (a WFH request and its review, an
onboarding step, a published policy) fans out a **notification row per
recipient**; each user reads and manages **only their own** through a header
**bell** and a full **inbox** page, and a tap **routes to the respective page**.

This is Phase 1 of the module — persisted delivery + the reusable publishing
spine + inbox UI. It is REST-only (no websocket): the badge polls every 30s and
on window focus. Live socket push, email/desktop-push channels, per-user
preferences (DND / mute) and WhatsApp-style grouping are **deferred** (see below).

## What the module guarantees

- **Recipient isolation (the headline requirement).** A notification belongs to
  exactly one `userId`. Every read and write in `NotificationService` is scoped
  by the caller's userId taken **from the JWT** (never a body/path param), so a
  user can never see or mutate another user's notifications. Marking a foreign
  id read is a silent no-op; the owner's row stays unread. The monolith's
  "phantom shared inbox" class of bug is closed by construction.
- **Everything sent is tracked.** Triggers `await` the notifier before the action
  returns, so a delivered notification is durably persisted before the API
  responds — it always appears in the recipient's panel. Delivery is
  **fail-safe**: `NotifierService` swallows its own errors, so a notification
  problem can never break the business action that triggered it.
- **A tap routes to the right page.** Every payload carries `data.actionUrl`
  (a web path). The shared frontend `resolveNotificationRoute` prefers that,
  falls back to a type→route map, and only ever returns an **app-internal** path
  (single leading slash) — an external/`javascript:`/`//host` value is refused
  (open-redirect guard).
- **You aren't told about your own action.** `notify` skips a notification whose
  recipient IS the actor.

## Endpoints

Base path `/api/v1/notifications`, guarded by `JwtAuthGuard`, self-scoped by the
token's userId.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/notifications` | The caller's own notifications, newest-first, cursor-paginated (`limit`, `before`, `unreadOnly`). Returns `{ items, nextCursor, unreadCount }`. |
| GET | `/notifications/unread-count` | The live unread badge count. |
| POST | `/notifications/:id/read` | Mark one read (own only). |
| POST | `/notifications/read-all` | Mark all the caller's unread read. |
| DELETE | `/notifications/:id` | Dismiss (hard-delete) one (own only). |
| POST | `/notifications/clear-read` | Delete all the caller's READ notifications. |
| POST | `/notifications/seed-demo` | Dev-only: seed sample routable notifications. Blocked in production. |

## The publishing spine

Any module emits notifications by importing `NotificationModule` and injecting
`NotifierService`:

- `notify({ organizationId, userId, actorId?, type, title, body?, data, priority? })`
  — one recipient.
- `notifyManagers({ organizationId, actorId?, resource, action, type, title, body?, data })`
  — fan out to every active member who can `resource:action` (owner/admin tier
  plus any custom-role holder whose matrix grants it — mirrors the guards).

Wired so far:
- **Attendance / WFH** — a request notifies the approvers (`attendance:edit`);
  the review notifies the requester (`wfh_request_submitted` / `wfh_request_reviewed`).
- **Onboarding** — initiation, document approval/rejection notify the hire
  (`onboarding_initiated` / `_document_verified` / `_document_rejected`).
- **Policy** — publishing an active `all`/`specific` policy notifies its audience
  (`policy_published`; department/designation audiences use the login ack gate).

## Data model

`notifications` (`Notifications1787860000000`): `organizationId`, `userId`
(recipient — the isolation key), `actorId` (who caused it), `type`, `category`
(derived: attendance|onboarding|policy|system), `title`, `body`, `data` (jsonb
routing hint), `priority`, `read`/`readAt`, `groupKey` (reserved), `isDeleted`.
Indexes: `(userId, createdAt)`, `(userId, read, isDeleted)`, `(organizationId, userId)`.

## Migration status

- Entity + `Notifications1787860000000` migration run against Supabase
  (registered in `test/global-setup.ts`).
- Additive and reversible; the Mongo monolith is untouched.

## Rollback

Remove `NotificationModule` from `app.module.ts` and the `NotificationModule`
imports from Attendance/Onboarding/Policy modules; the `notify*` calls are all
`await`ed but fail-safe, so leaving them wired with the module removed would fail
DI at boot — remove the imports together. `migration:revert` drops the table.

## Scenarios & tests

- Backend e2e (`features/notification.feature`, jest-cucumber): approvers-notified
  / requester-and-bystanders-not, review-notifies-requester-with-route,
  only-your-own-notifications, cross-user-mark-read-is-a-no-op, mark-all-read +
  clear-read, requires-authentication. **6 scenarios, all green.**
- Frontend unit (vitest): `notification-route.test` (routing + open-redirect
  guard), `notification-visuals.test` (category meta + relative time).

## Preferences (Settings → Notifications)

Per-user delivery preferences are ENFORCED at `NotifierService.notify` time via
`NotificationPreferenceService.allows(userId, type, priority)` (fails open):
`notification_preferences` row holds a master `inApp`, per-category toggles
(attendance/onboarding/policy/system), and Do-Not-Disturb (`dndEnabled` +
`dndAllowUrgent`). Off ⇒ the notification is never persisted (not cosmetic).
Endpoints `GET/PUT /notifications/preferences`. e2e:
`notification-preferences.feature` (defaults-on, category-off suppresses,
DND suppresses non-urgent, DND allows urgent).

## Real-time push (FCM Web Push)

Every in-app notification the notifier creates is also pushed to the recipient's
registered browsers over **FCM HTTP v1** (`push/fcm.client.ts` — signed service-account
JWT → OAuth token, no firebase-admin) as a **data-only** message
`{ kind:'notification', notificationId, type, title, body, actionUrl, meetingId?, priority }`.
Only pushed when the in-app row is actually created (prefs/org policy/dedupe/self-action
respected); fire-and-forget; tokens FCM reports UNREGISTERED/invalid are deleted.

- **Tokens** — `push_tokens` (migration `1788460000000-PushTokens`): one row per token,
  re-registering moves it to the current user. `GET /push/config` (web config; `enabled`
  only with a complete service account + `FCM_WEB_API_KEY`/`FCM_WEB_APP_ID`/
  `FCM_MESSAGING_SENDER_ID` + `VAPID_PUBLIC_KEY`), `POST /push/tokens {token}`,
  `DELETE /push/tokens {token}` (own tokens only; called on sign-out).
- **Web** — `public/firebase-messaging-sw.js` (dependency-free) forwards each push to open
  tabs and shows a desktop notification only when no tab is visible (click → `actionUrl`).
  `lib/push.ts` re-dispatches it as the `nugenova:push` window event; the bell refreshes
  instantly and the meeting join popup opens on `meeting_*` pushes (its polling relaxes to
  60 s when push is on). `PushPrompt` asks once from a click ("Turn on"), re-offers after
  14 days, silently refreshes the token when permission is already granted. Without
  config/permission everything falls back to the existing polling.

## Deferred (Phase 2)

- Live socket/websocket push (currently 30s poll + focus refresh).
- Email / desktop-push channels (the preference model is in-app only for now).
- WhatsApp-style grouping (`groupKey`/`count`) to collapse bursts.
- Additional triggers (attendance manual-entry review, onboarding completion,
  department/designation policy audiences).
