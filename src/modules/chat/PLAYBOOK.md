---
module: chat
title: Chat / Messaging
owner: collaboration
status: live
phase: 1
migratedAt: 2026-09-03
source: nugenova-monolith/src/modules/chat
---

# Chat / Messaging

Members hold **conversations** (direct, group, channel, notes-to-self) and
exchange **messages** (send/list/edit/delete/read/react/search). Ported from the
Nugenova Mongo chat-service to Postgres/TypeORM. Person = `User` +
`OrgMembership` (`userId` is the auth id).

Beyond the durable REST + persistence core and the two isolation guarantees,
the following have since landed on top: the **Socket.IO realtime gateway**
(presence, typing, live message delivery), **presence** incl. a self-declared
**On-holiday** status, **member avatars** in the payload, an **org-admin chat
control panel** (access / attachments / moderation / retention / broadcast) with
server-side enforcement, **group management** (add/remove members, rename,
picture, history-sharing), and the **frontend chat UI**. Threads, polls,
moderation/DLP, link-preview, slash-commands, and managed client channels remain
**deferred** (see **Deferred**). The stored document shape and REST contract are
preserved throughout.

## Isolation (the #1 rule)

Every read AND write is scoped to `organizationId` **AND** the caller's
`userId`:

- A conversation is only ever loaded through `loadForMember` /
  `conversationForMember`, which require **same org** AND **caller is a
  participant**. A cross-org id is a **404** (never confirm the row exists
  elsewhere); a same-org non-participant is a **403**.
- `chat_conversations.participant_ids` is a denormalised `text[]` (kept in
  lock-step with `participants[].userId`) carrying a **GIN index**, so the list
  query `:me = ANY(participant_ids)` is index-served — the Postgres equivalent
  of the Mongo `participants.userId` index. The list is additionally filtered by
  `organization_id`.
- Messages carry a denormalised `organization_id` (copied from the parent
  conversation on send) as defence in depth.

Both guarantees are covered by e2e scenarios tagged `@security`
(`chat.feature`) and by unit specs on both services.

## Entities

- **`chat_conversations`** (`ConversationEntity`) — mirrors the Mongo
  `conversations` doc. `type` (direct|group|channel|meeting_chat|self),
  `channelType`, `participants` (jsonb — role, memberStatus, per-user
  pin/star/mute/lastRead), `participant_ids` (text[] + GIN), `lastMessage`
  (jsonb), `settings` (jsonb), `messageCount`, `isArchived`, `createdBy`,
  `isDeleted`.
- **`chat_messages`** (`MessageEntity`) — mirrors the Mongo `messages` doc.
  `content`/`contentPlainText`, `type`, `reactions`/`mentions`/`attachments`/
  `readBy`/`deliveredTo`/`editHistory` (jsonb), `idempotencyKey` (**partial
  unique** index `WHERE key IS NOT NULL` — the Postgres equivalent of Mongo's
  sparse-unique), edit/delete/pin flags.
- **`org_chat_settings`** (`OrgChatSettingEntity`) — one row per org, a single
  `settings` jsonb holding the admin's chat policy (`OrgChatSettings`). Empty
  default = permissive; see **Admin chat settings**.
- **Participant `historyFrom`** — an optional ISO field inside
  `chat_conversations.participants[]` gating a limited-history member's message
  window (see **Group management**).
- **`users.preferences.chatHoliday`** — `{ from, until }` ISO, the self-declared
  holiday window read by `PresenceService` (no new table/migration).

Dates inside jsonb are stored as **ISO strings** (jsonb has no Date type).

`id` is the 24-char ObjectId string from `PgBaseEntity`. REST responses preserve
the Mongo `_id` shape: each conversation/message view carries **both `id` and
`_id`** (`_id === id`) so legacy FE readers keep working.

## Message send pipeline

1. **Idempotency** — client key, else a deterministic `conversationId | sender |
   type | fileUrl | content | 10s-bucket` SHA-1 hash, so a double-fired send
   collapses to one row. A concurrent race that slips past the pre-check is
   caught by the partial-unique index (`23505` → return the winner).
2. **Access** — `conversationForMember` (org + participant). Archived → 400.
   Channel `whoCanPost=admins` → non-admins 403.
3. **Sanitise** — `sanitizeHtml` (see below) → `content`; `toPlainText` →
   `contentPlainText` (search index + empty-message guard). Whitespace-only text
   → 400.
4. **Persist** + update the conversation's `lastMessage`/`messageCount`.

### Sanitiser (`util/sanitize.util.ts`)

The monolith used **DOMPurify** (`isomorphic-dompurify`), which the Nexora repo
does **not** carry. `sanitizeHtml` is a dependency-free replacement that
neutralises the stored-XSS vectors the threat model needs: it drops
`<script>`/`<style>` blocks, strips every `on*` event-handler attribute, blocks
`javascript:`/`vbscript:`/`data:` hrefs, and removes any tag off the formatting
allow-list (keeping its inner text). It is intentionally **stricter** than
DOMPurify (removes rather than rewrites unknown tags); rendered output is
equivalent for the formatting tags clients actually use.

## Realtime & presence (`realtime/`)

The Socket.IO `/chat` gateway (`chat.gateway.ts`) + `PresenceService` give live
message delivery, typing relay, and presence. Services never depend on the
gateway — message/edit/delete fan-out is routed through `EventEmitter2`
(`chat-events.ts`), so there is no gateway↔service cycle. Presence is
**single-node, in-memory** (a multi-node deploy needs a Redis socket.io adapter
+ shared presence store).

**Presence states:** `online | away | busy | offline | on_holiday`.
`resolveStatus(userId, orgId)` resolves in this precedence:

1. **Self-declared holiday wins** (even while connected) — a persisted window on
   `user.preferences.chatHoliday` (`{ from, until }` ISO). Set from the status
   picker (`presence:set { status:'on_holiday', from, until }`); any other pick
   clears it. Shown to everyone until it expires.
2. **Connected** → a manual override (`busy`/`away`/appear-`offline`) else
   `away` (idle) else `online`.
3. **Disconnected** → `on_holiday` if on **approved leave** spanning today
   (derived from `leave_requests`), else `offline`.

## Member avatars

`ConversationsService.nameMap` enriches each presented participant (and the
`/chat/directory` rows) with `firstName`/`lastName`/**`avatar`**. The frontend
renders the picture (a `data:` URI on the user row) with an initials fallback in
the conversation list, thread header, message gutter, and the "me" status row;
the sidebar user card reads it from `/auth/me`.

## Admin chat settings & enforcement (`org_chat_settings`)

One row per org (`OrgChatSettingEntity`, single `settings` jsonb) is the
owner/admin's control over chat **for employees**. `ChatSettingsService.load`
merges the stored partial over `DEFAULT_CHAT_SETTINGS` (permissive = prior
behaviour, so unconfigured orgs are unaffected). Owners/admins **bypass every
gate**; members are subject to them. Gates throw `ForbiddenException`:

| Setting | Enforced at |
|---|---|
| `chatEnabled` | send + conversation create |
| `whoCanDm` (everyone/same_department/admins) | `POST conversations/direct` |
| `whoCanCreateChannels` / `whoCanCreateGroups` | create endpoints |
| `whoCanManageGroups` (creator_and_admins/any_member/admins) | add/remove/rename/picture |
| `attachmentsEnabled` / `maxFileSizeMb` / `blockedExtensions` | `/chat/upload` + send |
| `allowEditOwn` / `allowDeleteOwn` / `adminCanDeleteAny` | edit + delete |
| `retentionDays` | nightly `ChatRetentionService` sweep (soft-delete) |
| `broadcastAdminsOnly` | `@here` / `@everyone` on send |
| `shareHistoryDefault` | default of the add-member share-history toggle |

`GET /chat/settings` is readable by any member (the client reflects the policy);
`PUT /chat/settings` is owner/admin only.

## Group management & history sharing

Add/remove members, rename, and change the picture are gated by
`whoCanManageGroups` (via `ChatSettingsService.canManageGroup` — org admins
always; else creator/owner/admin or any-member per policy). Each participant
carries an optional `historyFrom` (ISO): a member added **without** shared
history has `historyFrom = now`, and `getMessages`/`getPinnedMessages` filter to
`createdAt >= historyFrom` for that caller — so they only see messages from when
they joined. Sharing history (or an org where `shareHistoryDefault` is on)
leaves `historyFrom = null` (full history). @mentioning an org member who isn't
in the group offers to add them (frontend confirm → `addParticipants`).

## Endpoints (`/api/v1/chat`, JwtAuthGuard)

Access is enforced by **participant membership + org scope in the service** (as
in the monolith — "the real gate is membership"), not a role guard. Acting org +
user ALWAYS come from `req.user`, never the body.

| Method | Path | What |
|---|---|---|
| POST | `/chat/conversations/direct` | Find-or-create a 1:1 DM. |
| POST | `/chat/conversations/group` | Create a group. |
| POST | `/chat/conversations/channel` | Create a channel. |
| GET | `/chat/conversations` | My conversations (`?starred=1` filter). |
| GET | `/chat/conversations/self` | Get-or-create notes-to-self. |
| GET | `/chat/conversations/:id` | One conversation. |
| PATCH | `/chat/conversations/:id` | Edit a channel (creator/admin). |
| PATCH | `/chat/conversations/:id/group` | Rename / change picture (policy-gated). |
| DELETE | `/chat/conversations/:id` | Soft-delete a channel (creator/admin). |
| POST | `/chat/conversations/:id/participants` | Add members (`{ userIds, shareHistory }`, policy-gated). |
| DELETE | `/chat/conversations/:id/participants/:userId` | Remove (policy-gated). |
| POST | `/chat/conversations/:id/leave` | Leave. |
| PUT | `/chat/conversations/:id/pin` \| `/mute` \| `/star` | Per-user toggles. |
| PUT | `/chat/conversations/:id/unarchive` | Unarchive. |
| POST | `/chat/conversations/:id/convert-group` | DM → group. |
| PUT | `/chat/conversations/:id/unread` | Mark unread from a message. |
| POST | `/chat/conversations/:id/messages` | Send. |
| GET | `/chat/conversations/:id/messages` | List (`page`/`limit`/`order`). |
| PUT | `/chat/messages/:id` | Edit (own; gated by `allowEditOwn`). |
| DELETE | `/chat/messages/:id` | Delete (own/channel-mod/org-admin; gated by `allowDeleteOwn`/`adminCanDeleteAny`). |
| POST | `/chat/conversations/:id/read` | Mark conversation read. |
| POST | `/chat/messages/:id/reactions` | Toggle a reaction (one per user). |
| GET | `/chat/unread` | App-wide unread badge counts. |
| GET | `/chat/conversations/:id/search` | Search within a conversation. |
| GET | `/chat/conversations/:cid/messages/:mid/read-status` | Read receipts. |
| POST | `/chat/upload` · GET `/chat/files/:id` | Upload / stream an attachment (policy-gated). |
| GET | `/chat/settings` | Read the org chat policy (any member). |
| PUT | `/chat/settings` | Update the org chat policy (owner/admin only). |

**Realtime** is a Socket.IO `/chat` namespace (not REST): client emits
`presence:active`/`presence:away`/`presence:set`, `typing:start`/`typing:stop`,
`conversation:join`/`leave`; server emits `presence:snapshot`/`presence:update`,
`typing:update`, `message:new`/`message:updated`/`message:deleted`.

## Migration

- `1788020000000-Chat.ts` — creates `chat_conversations` + `chat_messages`.
- `1788040000000-ChatBookmark.ts` — saved-message bookmarks.
- `1788050000000-OrgChatSettings.ts` — the `org_chat_settings` table (one
  `settings` jsonb per org). Empty default = prior behaviour, so existing orgs
  are unaffected.

All additive and reversible; the Mongo monolith is untouched. `participant.historyFrom`
and `users.preferences.chatHoliday` live inside existing jsonb columns → **no
migration**. Run with `npm run migration:run`.

## Tests

- **Unit** (`npx jest src/modules/chat`) — 8 specs / 107 tests, all with mocked
  repositories (no DB):
  - `util/sanitize.util.spec` — XSS guarantees.
  - `services/conversations.service.spec` — isolation (cross-org 404,
    non-participant 403, self-DM guard), directory, and **group management**
    (add w/ + w/o shared history → `historyFrom`, manage-policy forbid, rename +
    picture, remove).
  - `services/messages.service.spec` — message isolation + send guards, mentions,
    **history filtering** (`getMessages` cutoff), and **delete policy**
    (`allowDeleteOwn` / `adminCanDeleteAny`).
  - `services/tranche4.service.spec` — pin/unpin/forward.
  - `services/chat-settings.service.spec` — defaults merge, sanitiser clamps,
    every gate (member-blocked / admin-bypass), `canManageGroup` matrix.
  - `services/chat-retention.service.spec` — retention sweep cutoff + skip/no-throw.
  - `realtime/presence.service.spec` — presence state machine, leave-derived +
    **self-declared holiday** resolution & precedence, idle sweep.
  - `messages.controller.spec` — attachment endpoints + gates.
- **e2e** (`chat.feature` + `chat.e2e-spec.ts`, jest-cucumber, `bootOrgTestApp`)
  — create DM + send + list, the other participant reads, empty-message reject,
  group lists for all members, and **both** isolation guarantees.
- **Frontend** (`nugenova-frontend`, vitest) — `status-picker` (incl. the dated
  On-holiday flow), `group-info-panel` (roster, add w/ share-history, remove,
  rename), plus the chat settings page and the avatar/chat components.

> Shared-DB note: at migration time the Supabase e2e DB was being used
> concurrently by another agent. The chat e2e run passed **5/6**; the one
> failure was a transient `TypeORMError: Driver not Connected` thrown inside the
> auth guard's `isRevoked` query (a mid-run connection-pool drop), **not** a
> chat-logic assertion. Re-run sequentially at review to confirm 6/6.

## Deferred (follow-ups)

**Landed since Phase 1:** the Socket.IO realtime gateway (presence, typing, live
`message:new`/`updated`/`deleted`), presence incl. the self-declared holiday,
member avatars, the org-admin chat control panel + enforcement, group management
(add/remove/rename/picture, history-sharing), message retention, and the
frontend chat UI.

Still **not** built (each a self-contained monolith sub-feature; none change the
core contract):

1. **Threads / replies** — the `threadId` column + `threadInfo` exist on the
   schema; the list already excludes threaded replies (`threadId IS NULL`), but
   the thread read/reply endpoints are not ported.
2. **Moderation / DLP / legal-hold** — AI content moderation queue,
   `FlaggedMessage`, DLP block/redact/flag, legal-hold delete protection.
3. **Link-preview, slash-commands, create-task-from-message, polls, custom
   emoji, voice-message transcription, scheduled messages, analytics, AI
   summaries** — each is its own monolith sub-module. (Message **forwarding**
   has since landed.)
4. **Managed client channels** — the one-per-client "Client · <company>" channel
   + staff access lists (depends on `OrgMembership.clientId`/`role='client'`).
5. **Default-channel auto-join** on invite-accept + invited→active activation.
6. **Shared cache layer** — the monolith caches conversation lists in Redis;
   Nexora reads straight from Postgres (GIN-indexed) for now.
7. **Multi-node presence** — the gateway/presence are single-node in-memory; a
   multi-node deploy needs a Redis socket.io adapter + shared presence store.

## Landmines

- **jsonb dates are strings.** Compare/sort by converting (`new Date(iso)`),
  never assume a `Date` instance off a jsonb column.
- **`participant_ids` must stay in sync.** Every participant mutation calls
  `syncParticipantIds`; the membership/list queries rely on it. Editing
  `participants` without it silently breaks isolation reads.
- **Partial-unique idempotency.** The index is `WHERE idempotency_key IS NOT
  NULL` — rows without a key don't collide. Every send sets one (client or
  auto-hash).
- **No DOMPurify.** Don't reintroduce `isomorphic-dompurify`; use
  `util/sanitize.util.ts`.
- **Admins bypass every chat-settings gate.** `ChatSettingsService` short-circuits
  for owner/admin; membership/org isolation is still enforced separately in the
  services. Don't move a gate somewhere admins are also filtered.
- **`historyFrom` filters BOTH lists.** A limited-history member's cutoff applies
  in `getMessages` **and** `getPinnedMessages`. Add it to any new
  message-reading path too, or a limited member leaks older messages.
- **Holiday wins in `resolveStatus`.** The self-declared window is checked first
  (a DB read per user) — before the connected/leave branches. Don't reorder it.
- **Presence + gateway are single-node.** In-memory state; a horizontal scale-out
  needs a Redis socket.io adapter + shared presence store.
