# AI Chatbot (`ai-chat`) — PLAYBOOK

Async, RAG-grounded, multi-turn AI chatbot on top of the existing AI runtime
(`modules/ai`) and knowledge RAG (`modules/knowledge`). JWT-guarded; every
read/write is scoped to `organizationId` **and** `userId` — a user only ever
sees their own conversations.

## Why async (the whole point)

The default LLM provider is RunPod, whose cold-starts take **up to ~90s**. An AI
call must therefore **never** block the HTTP request. So:

- `POST /ai/chat/conversations/:id/messages` persists the user turn, creates a
  **pending** assistant message + a **queued** `ai_jobs` row, fires the work off
  the request path, and **returns immediately** (~ms). The LLM call is **not**
  awaited in the request.
- The client then **polls** `GET /ai/chat/messages/:id` until the assistant
  message's `status` flips `pending → done` (or `error`).

There is **no Redis/BullMQ** in this platform. Async is a **DB-backed job row +
in-process execution**: `AiJobService.submit()` saves a `queued` row and schedules
the worker with `setImmediate` (runs after the response is sent, never awaited).
`AiChatService` registers the `chat` worker on module init, so `AiJobService`
never imports a consumer (no circular DI).

## Components

| File | Role |
|------|------|
| `entities/ai-conversation.entity.ts` | `ai_conversations` — one thread per `(org,user)`; `lastMessageAt` drives the list. |
| `entities/ai-message.entity.ts` | `ai_messages` — turns. `user` complete on insert; `assistant` starts `pending`, filled by the worker. `sources` jsonb, `grounded`, `status`, `errorMessage`, `jobId`. |
| `entities/ai-job.entity.ts` | `ai_jobs` — background job rows: `queued→running→done\|error`, `input`/`result` jsonb. |
| `services/ai-job.service.ts` | Generic in-process job runner: `submit`, worker registry, orphan reap. Never throws into the request. |
| `services/ai-chat.service.ts` | Conversation CRUD + the async send flow + the `chat` worker (retrieve → ground → complete → write). |
| `ai-chat.controller.ts` | `/api/v1/ai/chat/*` HTTP surface. |
| migration `1788140000000-AiChat` | The three tables + indexes. |

AI feature tag: `chatbot` (added to `AiUsageFeature` in
`modules/ai/entities/ai-usage-event.entity.ts`) — every completion is metered
through `AiService.complete({ feature: 'chatbot' })`, so it inherits the full
tier/consent/usage policy gate **and** the usage ledger.

## API contract (`/api/v1/ai/chat`)

All JWT-guarded; org+user come from `req.user`. Responses use the `{success,data}`
envelope.

| Method & path | Body | `data` shape |
|---|---|---|
| `POST /conversations` | `{ title? }` | `{ id, title, lastMessageAt, createdAt }` |
| `GET /conversations` | — | `[{ id, title, lastMessageAt, updatedAt }]` (newest first, own only) |
| `GET /conversations/:id` | — | `{ id, title, messages: [{ id, role, content, sources, grounded, status, createdAt }] }` |
| `POST /conversations/:id/messages` | `{ content }` | `{ userMessage:{id,role:'user',content,createdAt}, assistantMessage:{id,role:'assistant',content:'',sources:[],grounded:false,status:'pending',jobId,createdAt} }` |
| `GET /messages/:id` | — | `{ id, role, content, sources:[{sourceId,sourceName,chunkIndex}], grounded, status, createdAt }` — **the poll target** |
| `DELETE /conversations/:id` | — | `{ deleted: true }` |

### Poll contract

1. Client `POST`s a message → gets back the `assistantMessage.id` with
   `status:'pending'`.
2. Client polls `GET /ai/chat/messages/:id` on an interval.
3. When `status === 'done'`: render `content` + `sources` (`grounded` tells the
   UI whether it was answered from org docs). When `status === 'error'`: show
   `errorMessage` and offer retry.

## Grounding (reuses `/ai/ask`)

The worker, for the latest user message:
1. `KnowledgeRetrievalService.search(orgId, query, topK)` — org-scoped FTS.
2. If chunks found → a **numbered, cited** system/context block + `grounded=true`
   + `sources` persisted on the message. If none → a **general** block +
   `grounded=false` + empty sources (**grounded-with-fallback**, exactly like
   `KnowledgeQaService`).
3. Assembles **conversation history** (prior `done` turns, capped to
   `MAX_HISTORY_MESSAGES = 12`, oldest-trimmed) + the new user turn, and calls
   `AiService.complete(feature:'chatbot', …)`.

## Process-restart orphan-job seam  ⚠️

Because execution is **in-process**, a crash/restart abandons any in-flight work:
no worker survives to finish a `queued`/`running` job or a `pending` assistant
message. Two reapers run on module init (`OnModuleInit`):

- **`AiJobService.reapOrphans()`** — marks `ai_jobs` rows stuck in
  `queued`/`running` **older than `ORPHAN_AGE_MS` (~10 min)** as
  `error('interrupted')`.
- **`AiChatService.reapOrphanedMessages()`** — flips `assistant` messages stuck
  `pending` past the same age to `status:'error'`, so a client polling an
  abandoned message stops waiting.

The **age guard** (~10 min) is deliberate: it avoids racing a job another
(already-running) process legitimately has in flight on a multi-node deploy. A
brand-new restart has nothing in flight, so fresh jobs are untouched.

**To replace for production scale:** swap the `setImmediate` execution + the two
reapers for a durable broker (BullMQ/Redis or a Postgres `SELECT … FOR UPDATE
SKIP LOCKED` poller) with real retry/visibility-timeout semantics. The HTTP
contract (submit→poll) does **not** change — only the execution engine behind
`AiJobService`.

## Isolation

- `AiChatService.loadOwnedConversation(org,user,id)` is the single gate: every
  conversation read/write (`get`, `send`, `delete`, message poll) goes through a
  `{ id, organizationId, userId }` filter and 404s otherwise.
- `ai_messages.organizationId` is denormalised from the parent for defence in
  depth, but the parent conversation's `userId` check is the primary gate — a
  message poll resolves its conversation with the org+user filter.
- Covered by specs: cross-user read, cross-org read, cross-user message poll, and
  list returning only the caller's own threads.

## Tests

`npx jest src/modules/ai-chat` — unit specs, fully mocked (no network, no DB):

- `ai-job.service.spec.ts` — submit persists `queued` and returns **without**
  running the worker; worker runs off-path → `done(result)`; worker throw →
  `error`; missing worker → `error`; `reapOrphans` errors stale rows, spares
  fresh/terminal ones.
- `ai-chat.service.spec.ts` — send creates a **pending** assistant + a job and
  returns **without** calling the LLM; worker moves `pending→done` and writes
  `sources` (grounded) / empty (fallback); completion tagged `feature:'chatbot'`;
  multi-turn history fed back; error path sets `status:'error'`; cross-user /
  cross-org isolation.

`test-fake-repo.ts` is an in-memory `Repository` stand-in (not a spec).

## Verification done

- `npx tsc --noEmit` clean; `npm run build` clean.
- Migration `up()` + `down()` validated on a throwaway local Postgres (never a
  shared dev/uat DB): all three tables, columns and indexes create and drop.

## Deferred

Streaming tokens (SSE/WS), regenerate/edit-and-resend, per-user rate limiting on
submit, and a durable multi-node queue (see the restart seam above).
