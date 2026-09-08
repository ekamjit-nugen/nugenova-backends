---
module: ai
title: AI Runtime (LLM provider abstraction + credit metering)
owner: platform
status: live
phase: 1
migratedAt: 2026-09-08
source: nexora-api/src/modules/ai + src/common/llm/llm-endpoint.ts
---

# AI Runtime

The platform's **one seam for every LLM call** plus the **AI-credit metering**
that §15 bills against. Ported from the legacy Mongo `ai` module + the
`common/llm/llm-endpoint.ts` helper to Postgres/TypeORM. Backend only.

Two halves:

1. **Provider abstraction** — every completion goes through an `LlmProvider`
   (`complete(messages, opts) → text + normalised token usage`). The live
   adapter is chosen by env and injected under the `LLM_PROVIDER` token, so call
   sites never know the vendor and specs bind a stub (no live API call in tests).
2. **Credit metering (§15)** — each call is written to an append-only **event
   ledger** and folded into a per-org/period **counter** (the "balance" a tier
   ceiling is compared against).

Person = `User` + `OrgMembership` (`userId` is the auth id). Every endpoint is
JWT-guarded and org-scoped; the acting org/user come from `req.user` only.

## Why it changed from the legacy module

The legacy module was hard-wired to a single **RunPod/vLLM** OpenAI-compatible
endpoint (`llm-endpoint.ts`) and stored usage in Mongoose with `costUsd: null`
(self-hosted → tokens only). The port:

- replaces the single-endpoint helper with a **pluggable `LlmProvider`**
  (Anthropic default, OpenAI-compatible, Ollama/local), selected by env;
- makes the Mongoose usage schemas **TypeORM entities** on Postgres;
- **estimates a USD cost** per call (the default provider, Claude, is hosted +
  per-token-priced) via a one-file price table;
- adds a **real tier / consent / usage policy** (`AI_POLICY` →
  `TierConsentUsagePolicy`) checked before every call — vertical-pack tier
  ceiling, guardian consent, and a per-org usage/credit ceiling (the ceiling
  legacy lacked);
- adds **role-gated usage-reporting reads** (`/ai/usage/events|by-user|summary`,
  owner/admin/hr) with actor enrichment, and **PII retention/redaction** over the
  stored prompt/output (legacy kept full plaintext forever).

Streaming, tool use, RAG and the many per-feature prompt helpers of the legacy
`AiService` (project plans, onboarding structure, …) are intentionally **not**
ported here — see **Deferred**.

## Provider abstraction

- `providers/llm-provider.ts` — the `LlmProvider` interface, message/usage
  types, `LLM_PROVIDER` DI token.
- `providers/anthropic.provider.ts` — **default**. Claude Messages API
  (`POST /v1/messages`), `x-api-key` + `anthropic-version`, system prompt split
  out of the messages array. Maps `usage.input_tokens/output_tokens`.
- `providers/openai.provider.ts` — OpenAI **Chat Completions** shape; also the
  path for any OpenAI-compatible gateway (Azure, the legacy RunPod/vLLM
  endpoint, OpenRouter) via `OPENAI_BASE_URL`.
- `providers/ollama.provider.ts` — local/self-hosted (`POST /api/chat`), no
  auth, zero marginal cost.
- `providers/llm-provider.factory.ts` — builds the one live adapter from env and
  binds it to `LLM_PROVIDER`.

All adapters use **global `fetch`** (Node ≥18), matching how `MailService` calls
ZeptoMail — **no axios / vendor SDK dependency** was added. **Network I/O lives
only inside `complete()`**, so unit specs bind a fake provider to the token and
never hit the wire.

### Config / env

| Env | Meaning | Default |
| --- | --- | --- |
| `AI_PROVIDER` (or legacy `CHATBOT_LLM_PROVIDER`) | `anthropic` \| `openai` \| `ollama`/`local` | `anthropic` |
| `AI_MODEL` | force a model for the active provider | per-provider default below |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL` | Anthropic | model `claude-sonnet-5` |
| `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL` | OpenAI/compatible | model `gpt-4o-mini` |
| `OLLAMA_MODEL`, `OLLAMA_BASE_URL` | Ollama | model `llama3.1`, url `http://localhost:11434` |
| `AI_USAGE_TOKEN_CAP` | per-org/period token ceiling (policy `usage_ceiling`); `0` disables | `5000000` |
| `AI_USAGE_TOKEN_CAP_TIER_<n>` | per-tier override of the token cap (wins over the global) | _(unset)_ |
| `AI_USAGE_COST_CAP_USD` | per-org/period est-USD ceiling; `0` disables | `0` (off) |
| `AI_CONSENT_PURPOSE` | guardian consent purpose checked when a subject is named | `ai` |
| `AI_PROMPT_STORAGE` | `redacted` \| `none` \| `full` — how prompt/output are stored | `redacted` |
| `AI_PROMPT_MAX_CHARS` | truncation length for `redacted` storage | `500` |
| `AI_PROMPT_RETENTION_DAYS` | PII TTL stamped on each row (`retainUntil`); `0` = keep forever | `30` |

**Default model ids** (`providers/llm-config.ts`, all named constants):

- Anthropic default **`claude-sonnet-5`** — the balanced current Claude for
  high-volume org features (chat/summarise/drafting): strong quality at ~½ the
  token price of Opus. Set `AI_MODEL=claude-opus-5` for the most capable current
  model or `claude-haiku-4-5` for the cheapest. These are the current-generation
  ids from the bundled claude-api reference (cached 2026-06); a newer id is a
  one-line bump in `llm-config.ts` + a price row in `model-pricing.ts`.
- OpenAI default **`gpt-4o-mini`**, Ollama default **`llama3.1`** — **best-effort
  ids, verify** (see **Landmines**).

## Credit-metering model (§15)

- **`ai_usage_events`** (`AiUsageEventEntity`) — append-only ledger, **one row
  per call**: `organizationId`, `userId`, `feature` (purpose), `provider`,
  `model`, `promptTokens`/`completionTokens`/`totalTokens`, `costUsd` (est.),
  `streamed`, `status` (`success`|`error`), and `prompt`/`output` (full audit
  text for §09). Indexed by (org, createdAt), (org, user), (org, feature).
- **`ai_usage_counters`** (`AiUsageCounterEntity`) — pre-aggregated rollup, **one
  row per (org, period)** where `period` is `YYYY-MM` (UTC). Holds the running
  token totals, est. `costUsd`, and `requestCount` — the O(1) **balance** a tier
  ceiling / credit allowance is compared against. **Unique (org, period)**, which
  is the `ON CONFLICT` target for the atomic upsert-increment.
- `AiUsageService.record(...)` writes the event AND increments the counter with
  an atomic `INSERT … ON CONFLICT (org, period) DO UPDATE SET x = x + EXCLUDED.x`
  (parallel calls never lose a write). It is **best-effort / never throws** —
  usage logging must not break an AI response — and **skips calls with no
  `organizationId`** (attribution is per-org).
- **Cost is an estimate**, not billing truth. `providers/model-pricing.ts` keeps
  USD/1M input+output prices in ONE table; an unknown model falls back to a
  mid-range price (flagged, never dropped). Token counts remain the record.

`bigint`/`numeric` columns come back as **strings** from TypeORM — the read path
(`getOrgBalance`/`getOrgSeries`) coerces with `Number()`. Keep that.

## Endpoints (`/api/v1/ai`, JWT-guarded, org-scoped)

- **`POST /ai/complete`** — run a completion through the active provider, meter
  it, return `{ text, provider, model, usage }`. Body: `messages[]` (1–100,
  role+content), optional `model`, `temperature` (0–2), `maxTokens` (1–8192),
  **`tier`** (0–3, default 1 — checked against the org ceiling), and
  **`subjectMembershipId`** (learner id → gates on guardian consent).
- **`GET /ai/usage`** — the caller's org AI-credit **balance** for the current
  (or `?period=YYYY-MM`) month + the full monthly **series**. Any org member.

### Usage-reporting reads (owner/admin/hr — `AiUsageRoleGuard`)

These three back the admin dashboard's AI usage panel (`nugenova-admin`
`aiUsageApi`, `src/lib/api.ts`). They are **role-gated**, not plain-JWT: only
`owner`/`admin`/`hr` (`orgRole` on the JWT). Rows are enriched with the resolved
actor `{ userId, name, email, role }` (join of `users` + `org_memberships`,
read-only). All numeric/bigint reads are `Number()`-coerced.

- **`GET /ai/usage/events`** — `{ success, data: AiUsageEvent[], pagination:
  { page, limit, total, totalPages } }`. Filter `?userId=`, `?feature=`,
  `?projectId=` (projectId is forward-compat; events carry `projectId:null`
  today), page `?page=`/`?limit=` (≤200). Each row: `_id`, `organizationId`,
  `userId`, `user` (actor), `feature`, `model`, token split, `costUsd|null`,
  `streamed`, `status`, **redaction-aware** `prompt`/`output`, `projectId`/
  `projectName`/`jobId` (null), `createdAt`/`updatedAt` (ISO).
- **`GET /ai/usage/by-user`** — `{ success, data: AiUsageByUser[] }`, biggest
  consumers first: `{ userId, user, totalTokens, promptTokens, completionTokens,
  requestCount, lastUsedAt }`.
- **`GET /ai/usage/summary`** — `{ success, data: { totalTokens, promptTokens,
  completionTokens, requestCount, userCount } }` (all-time org totals).

`AiService.complete()` is the exported entry point other modules use (with a
`feature` tag) — e.g. `AiService.summarize()` demonstrates the pattern.

## Tier / consent / usage policy (implemented)

`AiService.complete()` calls `AiPolicy.check(ctx)` **before** every provider
call; a deny throws `ForbiddenException` (HTTP 403) with the reason. The module
binds the **real** `TierConsentUsagePolicy` (`policy/tier-consent-usage-policy.ts`)
to `AI_POLICY` — replacing the old `AllowAllAiPolicy` (still exported as the
documented no-op fallback). It **never throws** (returns `{allowed:false, reason,
code}`), and runs three gates, first deny wins:

1. **Tier ceiling** — `VerticalPackService.aiTierCeiling(org)` vs the request's
   `tier` (default 1). Over → deny **`tier_ceiling`**.
2. **Consent** — only when `subjectMembershipId` is set:
   `GuardianService.isConsented(org, subject, purpose)` (`purpose` from
   `AI_CONSENT_PURPOSE`, default `ai`). Missing → deny **`not_consented`**. This
   check **fails closed** (an errored lookup denies). No subject → skipped.
3. **Usage ceiling** — `AiUsageService.getOrgBalance(org)` vs the configured
   per-org/period token cap (`AI_USAGE_TOKEN_CAP` / per-tier / default 5M) and
   optional cost cap (`AI_USAGE_COST_CAP_USD`). Over → deny **`usage_ceiling`**.
   **This is the ceiling legacy never had** (the self-hosted box was unmetered) —
   the improvement the old PLAYBOOK TODO called for. Caps live in
   `policy/ai-usage-limits.ts`.

**Context fields** (`AiPolicyContext`): `organizationId`, `userId`, `feature`,
`model`, `approxPromptChars`, `tier`, `subjectMembershipId`. **No org context →
allow** (nothing to meter/scope). Tier and usage checks **fail open** on an
unexpected infra error (logged) so a transient VerticalPack/DB blip degrades to
"unmetered gate", not "all AI down"; consent fails closed.

## PII retention / redaction

Legacy stored the **full** prompt + output in **plaintext, forever** — a
standing PII liability. This port makes storage a privacy-preserving choice
(`services/pii-redaction.ts`, applied in `AiUsageService.record`):

- `AI_PROMPT_STORAGE=redacted` **(default)** — store a **truncated** snippet
  (`AI_PROMPT_MAX_CHARS`, default 500) with a `… [redacted: +N chars]` marker.
- `AI_PROMPT_STORAGE=none` — store `''` (token counts still recorded).
- `AI_PROMPT_STORAGE=full` — opt back in to full plaintext (legacy behaviour).

Every event is stamped with `retainUntil = now + AI_PROMPT_RETENTION_DAYS`
(default 30; `0` = keep forever). `AiUsageService.purgeExpiredEvents()` scrubs
`prompt`/`output` (keeping the metering row) for rows past their TTL — safe to
run on a cron (no scheduler wired here; call it from an ops job). Column +
`ix_ai_usage_events_retain_until` index ship in the migration.

## Isolation (the #1 rule)

Every read/write is scoped to `organizationId` (from the trusted JWT). A member
can only ever read/spend against **their own** org's ledger; `GET /ai/usage`
takes the org from `req.user`, never the body. Covered by the `@security` e2e
scenario.

## Tests

- **Unit** (`npx jest src/modules/ai`, **27 tests, green**): `ai.service.spec`
  (policy gate allow/deny, provider invoked, success+error recorded, overrides
  passed, safe error message), `ai-usage.service.spec` (event write + atomic
  counter increment, cost math, no-org skip, never-throws, string coercion),
  `model-pricing.spec` (cost math + fallback + clamp), `ai-policy.spec` (default
  no-op fallback allows), **`tier-consent-usage-policy.spec`** (allow under
  ceiling; deny over tier; deny without consent when a subject is set; deny over
  usage/cost cap; no-org allow; consent fails closed).
- **Gherkin + e2e** (`features/ai.feature`, `features/ai.e2e-spec.ts`) —
  **typecheck only, NOT executed** in this port (per instructions). The e2e
  **spies on the wired `LLM_PROVIDER` + `AI_POLICY` singletons** (`app.get(...)`
  then `jest.spyOn`) so no live LLM call is made; auth/org-scoping/metering/DB
  run for real if ever executed.

## Deferred (out of scope here — noted for later)

- **Per-feature generators** — the project/text/onboarding generation endpoints
  are NOT ported. The `AiUsageFeature` enum is kept **forward-compatible** (it
  already lists `project_plan`, `onboarding_structure`, `text_improve`, … as
  plain-text values, no migration to add one) but those features aren't wired.
- **Consumer modules** — chatbot Nova and the chat/meeting/folio/resume AI
  helpers are not ported; they meter through `AiUsageService` when they land.
- **Credit top-up / billing** — the counters are consumption only; no
  allowance/top-up/reset ledger yet, and `costUsd` is an estimate, not invoiced.
  The usage **ceiling** is now enforced (`TierConsentUsagePolicy`), but a
  top-up/reset workflow above it is future work.
- **Purge scheduler** — `purgeExpiredEvents()` exists but no cron calls it here;
  wire it into an ops job (§08 scheduler) when retention is enforced.
- **Streaming (SSE)** responses — the legacy `chatStream` + record-once-on-any-
  end logic is not ported; the `streamed` column + interface are reserved for it.
- **RAG doubt-tutor + generative narratives (§09)** — retrieval, prompt
  templates, and the per-feature helpers (project plan, onboarding structure,
  milestones) from the legacy `AiService`.
- **Model-routing for cost** — pick model per feature/tier (cheap model for
  bulk, capable model for hard tasks); the seam is `opts.model` + the price table.
- **Prompt/response audit logging per §09 guardrails** — `prompt`/`output` are
  already captured on every event; the review/redaction/retention surface over
  them is not built.
- Swap adapters to the **official `@anthropic-ai/sdk` / `openai`** clients if a
  dependency is acceptable (adds thinking, tool use, structured outputs).

## Landmines

- **Provider cost-profile FLIP — confirm `AI_PROVIDER` before cutover.** Legacy
  actually ran a **self-hosted qwen** (RunPod/vLLM): tokens were **free at the
  margin** (`costUsd: null`). This port defaults to **hosted Anthropic**, which
  is **per-token priced** — flipping the cost profile from ~$0 to real dollars,
  and the cached default ids/prices below are estimates. **Ops MUST explicitly
  set/confirm `AI_PROVIDER`** (+ `AI_MODEL`/keys) before go-live: leaving the
  default silently bills every call to Anthropic. Point `AI_PROVIDER=ollama`
  (or `openai` at an OpenAI-compatible qwen gateway) to keep the self-hosted
  profile.
- **Model ids drift + cached prices.** The Anthropic default ids/prices are
  **cached** (claude-api reference, 2026-06); **OpenAI/Ollama default ids are
  best-effort — verify** against the vendor's current list before relying on
  cost/behaviour. All ids are named constants in `llm-config.ts`; prices in
  `model-pricing.ts`. Bump both together.
- **`costUsd` is an estimate** (list price, non-batch, non-cached). Do not treat
  it as invoiced spend; token counts are the source of truth.
- **`record()` swallows errors by design** — a metering failure must never break
  a response. Watch the logs (`AiUsageService`) for silent drops.
- **`numeric`/`bigint` read back as strings** — always `Number()` them (the read
  path already does).
- **Migration renumbered `1788090000000` → `1788120000000`.** The original
  `1788090000000-AiUsage` **collided** with `1788090000000-PlatformLimits` on
  integration/demo. On merge it was renumbered to `1788120000000` (file, class
  `AiUsage1788120000000`, `name`, and both arrays of `test/global-setup.ts`).
  Verified: the full chain runs on a fresh DB with PlatformLimits then AiUsage,
  no collision. Any NEW migration must exceed `1788120000000` and be registered
  in both `test/global-setup.ts` arrays or CI's fresh DB lacks the tables.
- **No live API calls in specs** — always mock the `LLM_PROVIDER` token (unit) or
  spy the singleton (e2e). Never let a spec reach a provider's `complete()`.
