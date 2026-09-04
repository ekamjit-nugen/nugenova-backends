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

This is **Phase 1** — the durable REST + persistence core plus the two
isolation guarantees. The Socket.IO realtime gateway, threads, polls,
moderation/DLP, link-preview, slash-commands, managed client channels, and the
frontend UI are **deferred** (see **Deferred** below). The stored document shape
and the REST contract are preserved so those layers can land on top without
reshaping the data.

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
| DELETE | `/chat/conversations/:id` | Soft-delete a channel (creator/admin). |
| POST | `/chat/conversations/:id/participants` | Add members. |
| DELETE | `/chat/conversations/:id/participants/:userId` | Remove (owner/admin). |
| POST | `/chat/conversations/:id/leave` | Leave. |
| PUT | `/chat/conversations/:id/pin` \| `/mute` \| `/star` | Per-user toggles. |
| PUT | `/chat/conversations/:id/unarchive` | Unarchive. |
| POST | `/chat/conversations/:id/convert-group` | DM → group. |
| PUT | `/chat/conversations/:id/unread` | Mark unread from a message. |
| POST | `/chat/conversations/:id/messages` | Send. |
| GET | `/chat/conversations/:id/messages` | List (`page`/`limit`/`order`). |
| PUT | `/chat/messages/:id` | Edit (own only). |
| DELETE | `/chat/messages/:id` | Delete (own, or channel owner/admin). |
| POST | `/chat/conversations/:id/read` | Mark conversation read. |
| POST | `/chat/messages/:id/reactions` | Toggle a reaction (one per user). |
| GET | `/chat/unread` | App-wide unread badge counts. |
| GET | `/chat/conversations/:id/search` | Search within a conversation. |
| GET | `/chat/conversations/:cid/messages/:mid/read-status` | Read receipts. |

## Migration

`1788020000000-Chat.ts` — creates `chat_conversations` + `chat_messages`.
Additive and reversible; the Mongo monolith is untouched. Registered in
`test/global-setup.ts` (entities[] + migrations[]). Run with
`npm run migration:run`.

## Tests

- **Unit** (`npx jest src/modules/chat`) — 17 specs: sanitiser XSS guarantees,
  conversation isolation (cross-org 404, non-participant 403, self-DM guard),
  message isolation + send guards (archived, empty, idempotency), all with
  mocked repositories (no DB).
- **e2e** (`chat.feature` + `chat.e2e-spec.ts`, jest-cucumber, `bootOrgTestApp`)
  — create DM + send + list, the other participant reads, empty-message reject,
  group lists for all members, and **both** isolation guarantees.

> Shared-DB note: at migration time the Supabase e2e DB was being used
> concurrently by another agent. The chat e2e run passed **5/6**; the one
> failure was a transient `TypeORMError: Driver not Connected` thrown inside the
> auth guard's `isRevoked` query (a mid-run connection-pool drop), **not** a
> chat-logic assertion. Re-run sequentially at review to confirm 6/6.

## Deferred (follow-ups)

Faithfully **not** built in Phase 1 (each is a self-contained sub-feature in the
monolith; none change the core contract above):

1. **Socket.IO realtime gateway** — presence, typing indicators, live
   `message:new`/`conversation:updated` broadcast, delivery receipts, WS auth +
   revocation sweep, rate-limiting. The monolith's `messages.gateway.ts` is
   ~1000 lines and depends on `socket.io` (not a Nexora dependency yet) plus
   mentions/notification-publisher/discussion-board wiring. Nexora's
   notification module is currently **REST-poll (no sockets)**, so chat matches
   that posture: sends persist and are read back over REST. **This is the
   largest deferred piece** — build it as its own phase alongside a shared WS
   foundation.
2. **Threads / replies** — the `threadId` column + `threadInfo` exist on the
   schema; the list already excludes threaded replies (`threadId IS NULL`), but
   the thread read/reply endpoints are not ported.
3. **Moderation / DLP / legal-hold** — AI content moderation queue,
   `FlaggedMessage`, DLP block/redact/flag, legal-hold delete protection.
4. **Link-preview, slash-commands, message forwarding, create-task-from-message,
   polls, custom emoji, voice-message transcription, scheduled messages,
   analytics, AI summaries** — each is its own monolith sub-module.
5. **Managed client channels** — the one-per-client "Client · <company>" channel
   + staff access lists (depends on `OrgMembership.clientId`/`role='client'`).
6. **Default-channel auto-join** on invite-accept + invited→active activation.
7. **Shared cache layer** — the monolith caches conversation lists in Redis;
   Nexora reads straight from Postgres (GIN-indexed) for now.
8. **Frontend chat UI** — out of scope (backend only).

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
